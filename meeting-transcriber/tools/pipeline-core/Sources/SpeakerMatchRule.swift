import Foundation

/// The single, canonical speaker-match decision rule shared by both matchers
/// in the project: the app's distance-based `SpeakerMatcher` and mt-batch's
/// similarity-based `GlobalSpeakerDB`.
///
/// A detected voice is auto-named to an enrolled speaker only when cosine
/// SIMILARITY to that speaker is above `similarityFloor` AND the top-1/top-2
/// similarity gap is at least `similarityMargin`. Expressing the rule in
/// similarity keeps the two implementations in agreement — the distance-based
/// matcher derives its `distance < 1 - similarityFloor` ceiling from the same
/// floor, and the margin maps 1:1 because `dist2 - dist1 = sim1 - sim2`.
///
/// The two matchers used to duplicate these numbers with a cross-reference
/// comment because they lived in separate SPM packages; this shared target now
/// gives them one definition to import. Provisional values — the enrolled-voice
/// benchmark will re-fit them; when it does, change them **here only**.
public enum SpeakerMatchRule {
    /// Minimum cosine similarity for the primary match. Same-voice embeddings
    /// from the WeSpeaker model typically score 0.95+; the 0.65 floor is
    /// conservative enough that a cross-talk-contaminated centroid can't
    /// quietly steal a different speaker's name.
    public static let similarityFloor: Float = 0.65

    /// Required top-1 − top-2 similarity gap. Stops the case where two enrolled
    /// speakers both score around the floor — without the gap the matcher would
    /// flip-flop between them on tiny embedding noise.
    public static let similarityMargin: Float = 0.08
}
