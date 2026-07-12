import Foundation

/// Pure serialization + the **relabel-only validator** for MAX-tier pass P5,
/// the optional LLM semantic-repair step (DiarizationLM-style; Wang et al.,
/// "DiarizationLM: Speaker Diarization Post-Processing with Large Language
/// Models", 2024 — "completion" prompt flavour).
///
/// An LLM sees a compact `<spk:N> word word <spk:M> word …` serialization of a
/// window and is asked to *fix speaker tags only, never touch the words*. The
/// output cannot be trusted structurally, so this validator is the safety
/// boundary: it accepts a window's relabelling **only** when the returned word
/// sequence is byte-identical to the input after case/punctuation
/// normalization. Any drift — a paraphrase, an added/removed/re-ordered word —
/// rejects the whole window and keeps the pre-LLM labels. The LLM can therefore
/// only ever *move a speaker tag*; it can never rewrite the transcript.
///
/// Everything here is pure and deterministic (the caller owns the actual model
/// call), so the validator can be exhaustively unit-tested — which it must be.
public enum LLMSpeakerRepair {
    /// Default window length. ~4 minutes of speech keeps each prompt small
    /// enough for an 8B local model while giving it cross-turn context.
    public static let defaultWindowSeconds: TimeInterval = 240

    // MARK: - Serialization

    /// One serialized window: which words it covers (global indices into the
    /// caller's word array), the compact-id → real-label map, and the prompt
    /// body. Windows overlap by one utterance so the model keeps context across
    /// the seam; overlap words are re-labelled at most once (first window wins).
    public struct Window: Equatable, Sendable {
        public let index: Int
        public let wordIndices: [Int]
        public let labelMap: [String: String]
        public let serialized: String

        public init(index: Int, wordIndices: [Int], labelMap: [String: String], serialized: String) {
            self.index = index
            self.wordIndices = wordIndices
            self.labelMap = labelMap
            self.serialized = serialized
        }
    }

    /// Split attributed words into overlapping ~`windowSeconds` windows, each
    /// serialized as `<spk:N> …`. Windows break only on utterance boundaries
    /// (a speaker change) so a turn is never cut mid-way, and carry the prior
    /// window's final utterance as leading context.
    public static func serialize(
        words: [WordTimeline.AttributedWord],
        windowSeconds: TimeInterval = defaultWindowSeconds,
    ) -> [Window] {
        guard !words.isEmpty else { return [] }
        let utterances = utteranceRuns(words) // each run = contiguous same-speaker word indices
        guard !utterances.isEmpty else { return [] }

        var windows: [Window] = []
        var currentRuns: [[Int]] = []
        var windowStart = words[utterances[0][0]].word.start
        var carryOver: [Int]? // previous window's last utterance, for 1-utterance overlap

        func flush() {
            guard !currentRuns.isEmpty else { return }
            var indices: [Int] = []
            if let carry = carryOver { indices.append(contentsOf: carry) }
            indices.append(contentsOf: currentRuns.flatMap { $0 })
            let (map, text) = renderWindow(indices, words: words)
            windows.append(Window(index: windows.count, wordIndices: indices, labelMap: map, serialized: text))
            carryOver = currentRuns.last
            currentRuns = []
        }

        for run in utterances {
            let runStart = words[run[0]].word.start
            if !currentRuns.isEmpty, runStart - windowStart > windowSeconds {
                flush()
                windowStart = runStart
            }
            if currentRuns.isEmpty { windowStart = runStart }
            currentRuns.append(run)
        }
        flush()
        return windows
    }

    /// Group consecutive same-speaker words into utterance runs (index lists).
    public static func utteranceRuns(_ words: [WordTimeline.AttributedWord]) -> [[Int]] {
        var runs: [[Int]] = []
        var current: [Int] = []
        var speaker: String?
        for (i, w) in words.enumerated() {
            if let s = speaker, s != w.speaker {
                runs.append(current)
                current = []
            }
            current.append(i)
            speaker = w.speaker
        }
        if !current.isEmpty { runs.append(current) }
        return runs
    }

    /// Render one window: assign each distinct real label a compact `spk:N`
    /// (first-appearance order) and emit `<spk:N> word word …`, opening a new
    /// tag only on a speaker change.
    private static func renderWindow(
        _ indices: [Int],
        words: [WordTimeline.AttributedWord],
    ) -> (labelMap: [String: String], serialized: String) {
        var labelToId: [String: String] = [:]
        var idOrder = 0
        var parts: [String] = []
        var lastId: String?
        for idx in indices {
            let label = words[idx].speaker
            let id: String
            if let existing = labelToId[label] {
                id = existing
            } else {
                idOrder += 1
                id = "spk:\(idOrder)"
                labelToId[label] = id
            }
            if id != lastId {
                parts.append("<\(id)>")
                lastId = id
            }
            parts.append(words[idx].word.text)
        }
        // Invert to compact-id → real-label for the validator.
        var idToLabel: [String: String] = [:]
        for (label, id) in labelToId { idToLabel[id] = label }
        return (idToLabel, parts.joined(separator: " "))
    }

    /// The DiarizationLM-style instruction wrapping a window's serialization.
    public static func buildPrompt(window: Window) -> String {
        """
        You are correcting ONLY the speaker labels in a diarized transcript.

        Rules — follow exactly:
        - The text below tags each run of words with a speaker: <spk:1>, <spk:2>, …
        - Move a tag ONLY when the words clearly belong to a different speaker.
        - Never add, remove, reorder, or change ANY word. Output the same words in the same order.
        - Keep the same <spk:N> tag vocabulary. Do not invent new speakers.
        - Output ONLY the corrected tagged text, nothing else.

        Transcript:
        \(window.serialized)
        """
    }

    // MARK: - Validation (the safety boundary)

    /// Outcome of validating one window's LLM response.
    public struct WindowRepair: Equatable, Sendable {
        public let accepted: Bool
        /// global word index → new real label, for accepted windows only.
        public let moves: [Int: String]

        public init(accepted: Bool, moves: [Int: String]) {
            self.accepted = accepted
            self.moves = moves
        }
    }

    /// Validate one window's response. Accepts **only** when the response's word
    /// sequence equals the window's after normalization; then extracts per-word
    /// label moves. Any text drift → `accepted: false`, zero moves.
    public static func validate(
        window: Window,
        response: String,
        words: [WordTimeline.AttributedWord],
    ) -> WindowRepair {
        let parsed = parseTagged(response)
        // Response must have at least one tag+word; empty/garbage → reject.
        guard !parsed.isEmpty else { return WindowRepair(accepted: false, moves: [:]) }

        // Flatten response to (normalizedWord, compactId) in order.
        var responseSeq: [(word: String, id: String)] = []
        for (id, tokens) in parsed {
            for token in tokens {
                let norm = normalize(token)
                if norm.isEmpty { continue }
                responseSeq.append((norm, id))
            }
        }

        // Original window word sequence (normalized), aligned to global indices.
        var originalSeq: [(word: String, globalIndex: Int)] = []
        for idx in window.wordIndices {
            let norm = normalize(words[idx].word.text)
            if norm.isEmpty { continue }
            originalSeq.append((norm, idx))
        }

        // STRICT: identical length + identical tokens, in order. Else reject.
        guard responseSeq.count == originalSeq.count else {
            return WindowRepair(accepted: false, moves: [:])
        }
        for i in 0 ..< originalSeq.count where responseSeq[i].word != originalSeq[i].word {
            return WindowRepair(accepted: false, moves: [:])
        }

        // Words match — apply label moves. An unknown compact id (LLM invented
        // a tag) maps to nothing → keep the original label for that word.
        var moves: [Int: String] = [:]
        for i in 0 ..< originalSeq.count {
            let globalIndex = originalSeq[i].globalIndex
            guard let newLabel = window.labelMap[responseSeq[i].id] else { continue }
            if newLabel != words[globalIndex].speaker {
                moves[globalIndex] = newLabel
            }
        }
        return WindowRepair(accepted: true, moves: moves)
    }

    // MARK: - Apply across windows

    public struct RepairOutcome: Equatable, Sendable {
        public let words: [WordTimeline.AttributedWord]
        public let windowsAccepted: Int
        public let windowsRejected: Int
        public let labelsMoved: Int

        public init(words: [WordTimeline.AttributedWord], windowsAccepted: Int, windowsRejected: Int, labelsMoved: Int) {
            self.words = words
            self.windowsAccepted = windowsAccepted
            self.windowsRejected = windowsRejected
            self.labelsMoved = labelsMoved
        }
    }

    /// Validate every window against its response and apply the accepted moves.
    /// `responses[i]` is the model output for `windows[i]`; a missing/failed
    /// window (index absent) is treated as a rejection. Overlap words are moved
    /// at most once — the first accepted window that touches a word wins.
    public static func apply(
        words: [WordTimeline.AttributedWord],
        windows: [Window],
        responses: [Int: String],
    ) -> RepairOutcome {
        var result = words
        var applied = Set<Int>()
        var accepted = 0
        var rejected = 0
        var moved = 0
        for window in windows {
            guard let response = responses[window.index] else { rejected += 1; continue }
            let repair = validate(window: window, response: response, words: words)
            if repair.accepted {
                accepted += 1
                for (globalIndex, label) in repair.moves where !applied.contains(globalIndex) {
                    result[globalIndex].speaker = label
                    applied.insert(globalIndex)
                    moved += 1
                }
            } else {
                rejected += 1
            }
        }
        return RepairOutcome(words: result, windowsAccepted: accepted, windowsRejected: rejected, labelsMoved: moved)
    }

    // MARK: - Parsing & normalization

    /// Parse `<spk:N> words <spk:M> words` into `[(compactId, [wordTokens])]`,
    /// in order. Text before the first tag is ignored. Tags are matched
    /// case-insensitively and tolerate surrounding whitespace.
    static func parseTagged(_ text: String) -> [(id: String, words: [String])] {
        var out: [(id: String, words: [String])] = []
        // Split on the tag pattern, keeping the tag as a delimiter.
        let scanner = text
        var currentId: String?
        var buffer: [String] = []

        func flush() {
            if let id = currentId, !buffer.isEmpty {
                out.append((id, buffer))
            }
            buffer = []
        }

        // Tokenize into tags and words.
        var token = ""
        var i = scanner.startIndex
        while i < scanner.endIndex {
            let ch = scanner[i]
            if ch == "<" {
                // flush any pending word token
                if !token.isEmpty { buffer.append(token); token = "" }
                // read until '>'
                var tag = ""
                var j = scanner.index(after: i)
                while j < scanner.endIndex, scanner[j] != ">" {
                    tag.append(scanner[j])
                    j = scanner.index(after: j)
                }
                if let normalizedId = normalizeTag(tag) {
                    flush()
                    currentId = normalizedId
                }
                i = j < scanner.endIndex ? scanner.index(after: j) : j
                continue
            }
            if ch.isWhitespace {
                if !token.isEmpty { buffer.append(token); token = "" }
            } else {
                token.append(ch)
            }
            i = scanner.index(after: i)
        }
        if !token.isEmpty { buffer.append(token) }
        flush()
        return out
    }

    /// Normalize a `spk:N` / `spk N` / ` SPK:1 ` tag body to a canonical
    /// `spk:N`, or `nil` when it isn't a speaker tag.
    static func normalizeTag(_ raw: String) -> String? {
        let lower = raw.lowercased().trimmingCharacters(in: .whitespaces)
        guard lower.hasPrefix("spk") else { return nil }
        let digits = lower.drop { !$0.isNumber }.prefix { $0.isNumber }
        guard !digits.isEmpty else { return nil }
        return "spk:\(digits)"
    }

    /// Lowercase + drop everything but unicode letters/numbers. A word that
    /// normalizes to empty (pure punctuation) is dropped from both sequences
    /// equally, so punctuation-only differences never trigger a false reject —
    /// but a real word change ("cat" → "cats") always does.
    public static func normalize(_ word: String) -> String {
        String(word.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) })
    }
}
