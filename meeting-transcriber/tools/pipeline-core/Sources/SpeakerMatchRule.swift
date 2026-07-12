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
/// gives them one definition to import. These are the **mainline-equivalent**
/// defaults (the app matcher's distance ceiling 0.40 = similarity floor 0.60,
/// margin 0.10), so already-enrolled voices keep matching. The enrolled-voice
/// quality lane re-fits them from data; when it does, change them **here only**.
public enum SpeakerMatchRule {
    /// Minimum cosine similarity for the primary match (distance ceiling 0.40 on
    /// the app matcher). Same-voice WeSpeaker embeddings typically score 0.95+;
    /// 0.60 is conservative enough that a cross-talk-contaminated centroid can't
    /// quietly steal a different speaker's name, without regressing existing
    /// enrolments that match around 0.6.
    public static let similarityFloor: Float = 0.60

    /// Required top-1 − top-2 similarity gap. Stops the case where two enrolled
    /// speakers both score around the floor — without the gap the matcher would
    /// flip-flop between them on tiny embedding noise.
    public static let similarityMargin: Float = 0.10
}
