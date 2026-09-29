import Foundation

/// Locates and supervises the bundled Node engine. The engine runs as a launchd agent so MCP
/// servers keep serving Claude Code / Codex / SSH sessions even when this app is closed.
enum Engine {
    /// Engine entry point: bundled in the .app, or overridden for development.
    static var cliPath: String? {
        if let env = ProcessInfo.processInfo.environment["MCPM_ENGINE_CLI"] { return env }
        if let url = Bundle.main.resourceURL?.appendingPathComponent("engine/dist/cli.js"),
           FileManager.default.fileExists(atPath: url.path) {
            return url.path
        }
        return nil
    }

    static func nodePath() async -> String? {
        if let out = try? await run("/bin/zsh", ["-l", "-c", "command -v node"]).output,
           let line = out.split(separator: "\n").last.map(String.init),
           FileManager.default.isExecutableFile(atPath: line) {
            return line
        }
        return ["/opt/homebrew/bin/node", "/usr/local/bin/node"].first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// Run `node cli.js <args>` and return its output.
    @discardableResult
    static func cli(_ args: [String]) async throws -> String {
        guard let cli = cliPath else {
            throw APIError(message: "Engine not found inside the app bundle. Rebuild with scripts/build-app.sh.")
        }
        guard let node = await nodePath() else {
            throw APIError(message: "Node.js was not found. Install it with `brew install node` and relaunch.")
        }
        let result = try await run(node, [cli] + args)
        if result.status != 0 { throw APIError(message: result.output.trimmingCharacters(in: .whitespacesAndNewlines)) }
        return result.output
    }

    static func installService() async throws { try await cli(["service", "install"]) }
    static func uninstallService() async throws { try await cli(["service", "uninstall"]) }
    static func restartService() async throws { try await cli(["service", "restart"]) }

    struct RunResult { var status: Int32; var output: String }

    static func run(_ executable: String, _ args: [String]) async throws -> RunResult {
        try await withCheckedThrowingContinuation { cont in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: executable)
            p.arguments = args
            let pipe = Pipe()
            p.standardOutput = pipe
            p.standardError = pipe
            p.standardInput = FileHandle.nullDevice
            p.terminationHandler = { proc in
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                cont.resume(returning: RunResult(status: proc.terminationStatus, output: String(decoding: data, as: UTF8.self)))
            }
            do { try p.run() } catch { cont.resume(throwing: error) }
        }
    }
}
