// swiftlint:disable discouraged_optional_collection
// `centroid: [Float]?` and `lastUsed: Date?` use nil to signal "absent",
// which is semantically distinct from an empty collection — matches the
// main app's StoredSpeaker schema so the two writers stay byte-compatible.
import Foundation

/// On-disk speaker entry — schema mirrors `StoredSpeaker.swift` in the main
/// app so `speakers.json` is round-trip compatible across both writers.
///
/// The CLI doesn't perform fuzzy matching itself; for an unattended batch
/// run we just persist one entry per unique diarization speaker label we
/// encountered, with the centroid embedding FluidAudio produced. A future
/// run (either the GUI app or another `mt-batch` invocation) can match
/// against these centroids and reuse the same name.
struct StoredSpeakerEntry: Codable {
    let name: String
    let embeddings: [[Float]]
    let centroid: [Float]?
    let centroidSampleCount: Int
    let lastUsed: Date?
    let useCount: Int
    let isSynthetic: Bool

    init(
        name: String,
        embeddings: [[Float]],
        centroid: [Float]? = nil,
        centroidSampleCount: Int = 0,
        lastUsed: Date? = nil,
        useCount: Int = 0,
        isSynthetic: Bool = false,
    ) {
        self.name = name
        self.embeddings = embeddings
        self.centroid = centroid
        self.centroidSampleCount = centroidSampleCount
        self.lastUsed = lastUsed
        self.useCount = useCount
        self.isSynthetic = isSynthetic
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        if let multi = try? container.decode([[Float]].self, forKey: .embeddings) {
            embeddings = multi
        } else if let single = try? container.decode([Float].self, forKey: .embedding) {
            embeddings = [single]
        } else {
            embeddings = []
        }
        centroid = try container.decodeIfPresent([Float].self, forKey: .centroid)
        centroidSampleCount = try container.decodeIfPresent(Int.self, forKey: .centroidSampleCount) ?? 0
        // `lastUsed` is Unix-epoch seconds on disk (the format Timbre/Electron
        // writes) — decode/encode it explicitly, not via the default `Date`
        // strategy (seconds-since-2001), so this reader stays byte-compatible
        // with the unified global DB the main app and Electron share.
        lastUsed = try container.decodeIfPresent(Double.self, forKey: .lastUsed)
            .map(Date.init(timeIntervalSince1970:))
        useCount = try container.decodeIfPresent(Int.self, forKey: .useCount) ?? 0
        isSynthetic = try container.decodeIfPresent(Bool.self, forKey: .isSynthetic) ?? false
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        try container.encode(embeddings, forKey: .embeddings)
        try container.encodeIfPresent(centroid, forKey: .centroid)
        if centroidSampleCount > 0 {
            try container.encode(centroidSampleCount, forKey: .centroidSampleCount)
        }
        // Unix-epoch seconds — see the decode note; matches Electron's writer.
        try container.encodeIfPresent(lastUsed?.timeIntervalSince1970, forKey: .lastUsed)
        if useCount > 0 {
            try container.encode(useCount, forKey: .useCount)
        }
        if isSynthetic {
            try container.encode(isSynthetic, forKey: .isSynthetic)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case name, embeddings, embedding, centroid, centroidSampleCount,
             lastUsed, useCount, isSynthetic
    }
}

/// Read-modify-write the per-run `speakers.json` next to the output. The
/// CLI writes this DB *into the output dir* (not into the user's global
/// `~/Library/Application Support/MeetingTranscriber/speakers.json`) so an
/// unattended batch run can never poison the main app's voice DB. The
/// Electron parent / operator can choose to merge it manually after review.
enum SpeakerDB {
    /// Quality threshold for folding an embedding into the centroid.
    /// Matches `SpeakerMatcher.minSpeakingTimeForCentroid`.
    static let minSpeakingTimeForCentroid: TimeInterval = 3.0

    /// FIFO size for recent samples (the centroid is the primary anchor;
    /// samples are a fallback). Matches `SpeakerMatcher.maxRecentSamples`.
    static let maxRecentSamples = 3

    /// Load the DB from `url` if it exists, otherwise an empty list.
    static func load(from url: URL) -> [StoredSpeakerEntry] {
        guard let data = try? Data(contentsOf: url),
              let entries = try? JSONDecoder().decode([StoredSpeakerEntry].self, from: data) else {
            return []
        }
        return entries
    }

    /// Write `entries` to `url` atomically (write to tmp + replace).
    static func save(_ entries: [StoredSpeakerEntry], to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(entries)
        let tmp = url.deletingLastPathComponent()
            .appendingPathComponent("\(url.lastPathComponent).tmp")
        try data.write(to: tmp)
        _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
    }

    /// Apply a batch of diarized embeddings to a DB and return the new state.
    ///
    /// Behaviour:
    ///  - For each `(label → embedding)` pair, if a stored entry exists with
    ///    the same name (== diarization label, since we're unattended) update
    ///    its centroid + recent-samples FIFO using a running average.
    ///  - Otherwise append a fresh entry. The entry's `centroid` is seeded
    ///    only when the speaker has at least `minSpeakingTimeForCentroid`
    ///    seconds in this run — short snippets are kept as fallback samples
    ///    but don't pollute the running average.
    static func apply(
        existing: [StoredSpeakerEntry],
        embeddings: [String: [Float]],
        speakingTimes: [String: TimeInterval],
        now: Date = Date(),
    ) -> [StoredSpeakerEntry] {
        var byName: [String: StoredSpeakerEntry] = Dictionary(
            uniqueKeysWithValues: existing.map { ($0.name, $0) },
        )
        let sortedLabels = embeddings.keys.sorted()
        for label in sortedLabels {
            // swiftlint:disable:next force_unwrapping
            let embedding = embeddings[label]!
            let duration = speakingTimes[label] ?? 0
            if let prior = byName[label] {
                byName[label] = applyConfirmation(
                    to: prior, embedding: embedding, duration: duration, now: now,
                )
            } else {
                byName[label] = newEntry(
                    name: label, embedding: embedding, duration: duration, now: now,
                )
            }
        }
        // Stable ordering by name so consecutive runs produce byte-identical
        // diffs when nothing changed.
        return byName.keys.sorted().compactMap { byName[$0] }
    }

    /// Fold a new embedding into an existing entry's centroid + recent FIFO.
    static func applyConfirmation(
        to entry: StoredSpeakerEntry,
        embedding: [Float],
        duration: TimeInterval,
        now: Date,
    ) -> StoredSpeakerEntry {
        var samples = entry.embeddings
        samples.append(embedding)
        if samples.count > maxRecentSamples {
            samples.removeFirst(samples.count - maxRecentSamples)
        }

        let qualifies = duration >= minSpeakingTimeForCentroid
        let seedCentroid = entry.centroid ?? meanEmbedding(entry.embeddings)
        let seedCount = entry.centroid != nil
            ? entry.centroidSampleCount
            : (seedCentroid != nil ? entry.embeddings.count : 0)

        let nextCentroid: [Float]?
        let nextCount: Int
        if qualifies, let updated = updateCentroid(
            current: seedCentroid, count: seedCount, with: embedding,
        ) {
            nextCentroid = updated.centroid
            nextCount = updated.count
        } else {
            nextCentroid = seedCentroid
            nextCount = seedCount
        }
        return StoredSpeakerEntry(
            name: entry.name,
            embeddings: samples,
            centroid: nextCentroid,
            centroidSampleCount: nextCount,
            lastUsed: now,
            useCount: entry.useCount + 1,
            isSynthetic: entry.isSynthetic,
        )
    }

    /// Build a fresh entry from a single confirmation.
    static func newEntry(
        name: String, embedding: [Float], duration: TimeInterval, now: Date,
    ) -> StoredSpeakerEntry {
        let qualifies = duration >= minSpeakingTimeForCentroid
        return StoredSpeakerEntry(
            name: name,
            embeddings: [embedding],
            centroid: qualifies ? embedding : nil,
            centroidSampleCount: qualifies ? 1 : 0,
            lastUsed: now,
            useCount: 1,
        )
    }

    /// Running-average centroid update: `new = (current * n + sample) / (n + 1)`.
    /// Returns nil if the sample dimensionality doesn't match the centroid.
    static func updateCentroid(
        current: [Float]?, count: Int, with sample: [Float],
    ) -> (centroid: [Float], count: Int)? {
        guard !sample.isEmpty else { return nil }
        guard let current, !current.isEmpty else {
            return (sample, 1)
        }
        guard current.count == sample.count else { return nil }
        let n = Float(count)
        let total = n + 1
        var updated = [Float](repeating: 0, count: current.count)
        for i in 0 ..< current.count {
            updated[i] = (current[i] * n + sample[i]) / total
        }
        return (updated, count + 1)
    }

    /// Element-wise mean of equal-length vectors.
    static func meanEmbedding(_ vectors: [[Float]]) -> [Float]? {
        guard let first = vectors.first, !first.isEmpty else { return nil }
        let dim = first.count
        guard vectors.allSatisfy({ $0.count == dim }) else { return nil }
        var sum = [Float](repeating: 0, count: dim)
        for vec in vectors {
            for i in 0 ..< dim {
                sum[i] += vec[i]
            }
        }
        let n = Float(vectors.count)
        return sum.map { $0 / n }
    }
}

// swiftlint:enable discouraged_optional_collection
