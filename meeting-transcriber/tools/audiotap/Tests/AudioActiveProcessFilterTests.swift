@testable import AudioTapLib
import CoreAudio
import XCTest

final class AudioActiveProcessFilterTests: XCTestCase {
    private func candidate(pid: pid_t, id: AudioObjectID) -> AudioActiveProcessFilter.Candidate {
        (pid: pid, audioObjectID: id)
    }

    func testRootKeptEvenWhenSilentAndActivesFollow() {
        let candidates = [
            candidate(pid: 100, id: 10), // root, silent
            candidate(pid: 101, id: 11), // active
            candidate(pid: 102, id: 12), // silent
        ]
        let table: [AudioObjectID: Bool] = [10: false, 11: true, 12: false]
        let result = AudioActiveProcessFilter.filter(
            candidates: candidates,
            isRunningOutput: { table[$0] },
            rootPID: 100,
            cap: 8,
        )
        // Root first (kept despite silence), then the active one; silent dropped.
        XCTAssertEqual(result.map(\.pid), [100, 101])
    }

    func testActivesKeptInKernelOrderRootFirst() {
        let candidates = [
            candidate(pid: 101, id: 11), // active (not root)
            candidate(pid: 100, id: 10), // root, active
            candidate(pid: 102, id: 12), // active
        ]
        let table: [AudioObjectID: Bool] = [10: true, 11: true, 12: true]
        let result = AudioActiveProcessFilter.filter(
            candidates: candidates,
            isRunningOutput: { table[$0] },
            rootPID: 100,
            cap: 8,
        )
        // Root first, then remaining actives in kernel order (11 before 12).
        XCTAssertEqual(result.map(\.pid), [100, 101, 102])
    }

    func testZeroActiveFallsBackToRootOnly() {
        let candidates = [
            candidate(pid: 100, id: 10),
            candidate(pid: 101, id: 11),
            candidate(pid: 102, id: 12),
        ]
        let table: [AudioObjectID: Bool] = [10: false, 11: false, 12: false]
        // Nothing emitting → tap the root ONLY, not the whole silent tree.
        let result = AudioActiveProcessFilter.filter(
            candidates: candidates,
            isRunningOutput: { table[$0] },
            rootPID: 100,
            cap: 8,
        )
        XCTAssertEqual(result.map(\.pid), [100])
    }

    func testUnknownPropsFillUpToCapAfterActives() {
        let candidates = [
            candidate(pid: 100, id: 10), // root, active
            candidate(pid: 101, id: 11), // unknown (absent → nil)
            candidate(pid: 102, id: 12), // unknown
        ]
        let table: [AudioObjectID: Bool] = [10: true]
        let result = AudioActiveProcessFilter.filter(
            candidates: candidates,
            isRunningOutput: { table[$0] },
            rootPID: 100,
            cap: 8,
        )
        // Active root, then unknowns fill the remaining slots.
        XCTAssertEqual(result.map(\.pid), [100, 101, 102])
    }

    func testHardCapEnforcedRootFirst() {
        // 10 active candidates (root among them), cap 3.
        let candidates = (0 ..< 10).map { candidate(pid: pid_t(200 + $0), id: AudioObjectID(20 + $0)) }
        var table: [AudioObjectID: Bool] = [:]
        for entry in candidates { table[entry.audioObjectID] = true }
        let result = AudioActiveProcessFilter.filter(
            candidates: candidates,
            isRunningOutput: { table[$0] },
            rootPID: 200,
            cap: 3,
        )
        XCTAssertEqual(result.count, 3)
        XCTAssertEqual(result.first?.pid, 200, "root stays first even under the cap")
    }

    func testZeroActiveWithUntranslatableRootFallsBackToCappedUnknowns() {
        // Root not present among candidates; nothing active; all unknown.
        let candidates = [
            candidate(pid: 101, id: 11),
            candidate(pid: 102, id: 12),
        ]
        let result = AudioActiveProcessFilter.filter(
            candidates: candidates,
            isRunningOutput: { _ in nil },
            rootPID: 999, // not in candidates
            cap: 8,
        )
        // No root, nothing active → best-effort capped unknowns.
        XCTAssertEqual(result.map(\.pid), [101, 102])
    }
}
