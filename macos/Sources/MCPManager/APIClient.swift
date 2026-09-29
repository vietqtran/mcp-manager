import Foundation

struct APIError: LocalizedError {
    var message: String
    var errorDescription: String? { message }
}

/// Talks to the local engine over HTTP. Port and token come from ~/.mcp-manager/config.json.
final class APIClient: @unchecked Sendable {
    static let dataDir: URL = {
        if let custom = ProcessInfo.processInfo.environment["MCP_MANAGER_HOME"] {
            return URL(fileURLWithPath: custom)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mcp-manager")
    }()

    private(set) var port = 7717
    private(set) var token = ""
    private let session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 60
        cfg.timeoutIntervalForResource = 60 * 30
        return URLSession(configuration: cfg)
    }()

    init() { reloadConfig() }

    func reloadConfig() {
        let file = Self.dataDir.appendingPathComponent("config.json")
        guard let data = try? Data(contentsOf: file),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let settings = obj["settings"] as? [String: Any] else { return }
        if let p = settings["port"] as? Int { port = p }
        if let t = settings["token"] as? String { token = t }
    }

    var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

    private func request(_ method: String, _ path: String, body: Data? = nil) -> URLRequest {
        var req = URLRequest(url: baseURL.appendingPathComponent("api").appendingPathComponent(path))
        req.httpMethod = method
        if !token.isEmpty { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return req
    }

    func send<T: Decodable>(_ method: String, _ path: String, json: Encodable? = nil, as: T.Type = T.self) async throws -> T {
        let body = try json.map { try JSONEncoder().encode($0) }
        let (data, response) = try await session.data(for: request(method, path, body: body))
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status >= 400 {
            let msg = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
            throw APIError(message: msg ?? "HTTP \(status)")
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError(message: "Unexpected response from engine: \(error)")
        }
    }

    func get<T: Decodable>(_ path: String) async throws -> T { try await send("GET", path) }
    func post<T: Decodable>(_ path: String, _ json: Encodable? = nil) async throws -> T { try await send("POST", path, json: json) }

    func ping() async -> Bool {
        var req = request("GET", "status")
        req.timeoutInterval = 2
        guard let (_, res) = try? await session.data(for: req) else { return false }
        return (res as? HTTPURLResponse)?.statusCode == 200
    }

    /// Server-sent events stream. Each `data:` line completes an event (the engine sends one per event).
    func events(_ path: String) -> AsyncThrowingStream<(event: String, data: Data), Error> {
        let req = request("GET", path)
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var cfgReq = req
                    cfgReq.timeoutInterval = 3600
                    let (bytes, _) = try await session.bytes(for: cfgReq)
                    var event = "message"
                    for try await line in bytes.lines {
                        if line.hasPrefix("event:") {
                            event = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
                        } else if line.hasPrefix("data:") {
                            let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                            continuation.yield((event, Data(payload.utf8)))
                            event = "message"
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
