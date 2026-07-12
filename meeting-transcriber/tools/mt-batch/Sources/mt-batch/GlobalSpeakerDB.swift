import Foundation

/// Read-only consumer of a globally-shared `speakers.json` for cross-meeting
/// speaker recognition.
///
/// The main app (Electron driver) is the sole *writer* — it merges per-meeting
/// embeddings into the global DB after user confirmation. `mt-batch` only ever
/// loads the file and uses the enrolled centroids to auto-name detected
/// clusters in subsequent meetings. Keeping the contract one-way avoids the
/// classic last-write-wins race between two concurrent transcoders.
///
/// Matching uses cosine *similarity* (1 - cosine distance) against each
/// stored speaker's centroid:
///   * `best > threshold` AND `(best - secondBest) >= margin` → assign.
///   * otherwise leave the diarization label untouched ("Speaker N").
///
/// Math is intentionally identical to the main app's
/// `SpeakerMatcher.cosineDistance`: dot / (||a|| * ||b||). We don't pre-L2-
/// normalize because the cosine ratio absorbs vector magnitude.
enum GlobalSpeakerDB {
    /// Default similarity threshold for the primary match. Same-voice
    /// embeddings from the WeSpeaker model typically score 0.95+; the 0.65
    /// floor is conservative enough that a cross-talk-contaminated centroid
    /// can't quietly steal a different speaker's name.
    ///
    /// This mirrors the unified decision rule the main app defines in
    /// `SpeakerMatcher.matchSimilarityFloor` (0.65). The two matchers live in
    /// separate SPM packages today, so the value is duplicated with this
    /// cross-reference rather than imported; the shared pipeline target will
    /// collapse them into one definition. Keep the numbers in lock-step.
    static let defaultMatchThreshold: Float = 0.65

    /// Default confidence margin between top-1 and top-2 candidates. Stops
    /// the case where two enrolled speakers both score around the threshold —
    /// without the gap we'd flip-flop between them on tiny embedding noise.
    /// Mirrors `SpeakerMatcher.matchSimilarityMargin` (0.08) — see above.
    static let defaultMatchMargin: Float = 0.08

    /// Outcome of matching one detected speaker against the enrolled DB.
    struct MatchResult {
        /// Diarization label produced this run (e.g. "Speaker 1").
        let detectedLabel: String
        /// Best-scoring enrolled name when the threshold + margin checks
        /// pass; nil otherwise (caller keeps `detectedLabel`).
        let enrolledName: String?
        /// Best similarity score against any enrolled centroid. nil only
        /// when the DB is empty.
        let bestSimilarity: Float?
        /// Second-best similarity. Used by tests and the JSONL event so the
        /// UI can show why a borderline match was rejected.
        let secondSimilarity: Float?
    }

    /// Load the global DB from disk. Missing file → empty list (callers treat
    /// "no file" the same as "no enrolled speakers"). Malformed JSON → empty
    /// list with a stderr warning; we never want a corrupt global DB to abort
    /// an entire transcription run.
    static func load(from url: URL) -> [StoredSpeakerEntry] {
        guard FileManager.default.fileExists(atPath: url.path) else {
            return []
        }
        guard let data = try? Data(contentsOf: url) else {
            Log.warn("Could not read global speakers DB at \(url.path)")
            return []
        }
        do {
            return try JSONDecoder().decode([StoredSpeakerEntry].self, from: data)
        } catch {
            Log.warn("Failed to parse global speakers DB at \(url.path): \(error)")
            return []
        }
    }

    /// Compare every diarization centroid against every enrolled centroid and
    /// return the per-label decision. Synthetic test entries are excluded —
    /// they carry random embeddings and would pollute auto-naming.
    static func match(
        detectedCentroids: [String: [Float]],
        enrolled: [StoredSpeakerEntry],
        threshold: Float = defaultMatchThreshold,
        margin: Float = defaultMatchMargin,
    ) -> [MatchResult] {
        let usable = enrolled.filter { !$0.isSynthetic }
        var results: [MatchResult] = []
        var claimedNames: Set<String> = []
        // Process labels in deterministic order so two runs over the same
        // inputs produce identical event lines (and identical name
        // collisions when the user enrolled the same voice twice).
        let labels = detectedCentroids.keys.sorted()
        for label in labels {
            // swiftlint:disable:next force_unwrapping
            let centroid = detectedCentroids[label]!
            let scored = usable
                .filter { !claimedNames.contains($0.name) }
                .compactMap { speaker -> (name: String, similarity: Float)? in
                    guard let storedCentroid = speaker.centroid else { return nil }
                    let sim = cosineSimilarity(centroid, storedCentroid)
                    return (speaker.name, sim)
                }
                .sorted { $0.similarity > $1.similarity }

            let best = scored.first
            let second = scored.count > 1 ? scored[1] : nil
            let bestSim = best?.similarity
            let secondSim = second?.similarity

            let assigned: String?
            if let best,
               best.similarity > threshold,
               best.similarity - (second?.similarity ?? -Float.infinity) >= margin {
                assigned = best.name
                claimedNames.insert(best.name)
            } else {
                assigned = nil
            }
            results.append(MatchResult(
                detectedLabel: label,
                enrolledName: assigned,
                bestSimilarity: bestSim,
                secondSimilarity: secondSim,
            ))
        }
        return results
    }

    /// Cosine similarity in `[-1, 1]`. Returns 0 for empty / mismatched-dim
    /// inputs — same defensive contract as `SpeakerMatcher.cosineDistance`,
    /// just expressed as similarity instead of distance.
    static func cosineSimilarity(_ a: [Float], _ b: [Float]) -> Float {
        guard a.count == b.count, !a.isEmpty else { return 0 }
        var dot: Float = 0
        var normA: Float = 0
        var normB: Float = 0
        for i in 0 ..< a.count {
            dot += a[i] * b[i]
            normA += a[i] * a[i]
            normB += b[i] * b[i]
        }
        let denom = sqrt(normA) * sqrt(normB)
        guard denom > 0 else { return 0 }
        return dot / denom
    }
}
