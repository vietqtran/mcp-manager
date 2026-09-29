import Foundation

/// Arbitrary JSON (tool schemas, tool results, preset defaults).
enum JSONValue: Codable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .object(let o): try c.encode(o)
        case .array(let a): try c.encode(a)
        case .null: try c.encodeNil()
        }
    }

    subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
    var arrayValue: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
    var objectValue: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }

    var pretty: String {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let data = try? enc.encode(self), let s = String(data: data, encoding: .utf8) else { return "" }
        return s
    }
}

enum ServerStatus: String, Codable {
    case stopped, starting, running, error
}

struct ServerInfo: Codable, Hashable {
    var name: String
    var version: String?
}

struct ServerView: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var description: String?
    var enabled: Bool
    var transport: String
    var presetId: String?
    var status: ServerStatus
    var error: String?
    var pid: Int?
    var startedAt: Double?
    var serverInfo: ServerInfo?
    var command: String
    var toolCount: Int
    var activeToolCount: Int
    var promptCount: Int
    var resourceCount: Int
}

struct KV: Codable, Hashable {
    var key: String
    var value: String?
    var secret: Bool?
    var hasValue: Bool?
}

struct ServerDef: Codable, Hashable {
    var id: String
    var name: String
    var description: String?
    var enabled: Bool
    var transport: String
    var command: String?
    var args: [String]?
    var env: [KV]?
    var cwd: String?
    var url: String?
    var headers: [KV]?
    var disabledTools: [String]?
    var fixedArgs: [KV]?
    var presetId: String?
    var createdAt: String?
    var updatedAt: String?
}

struct ToolInfo: Codable, Identifiable, Hashable {
    var name: String
    var title: String?
    var description: String?
    var inputSchema: JSONValue?
    var id: String { name }
}

struct PromptInfo: Codable, Identifiable, Hashable {
    var name: String
    var description: String?
    var id: String { name }
}

struct ResourceInfo: Codable, Hashable {
    var uri: String?
    var uriTemplate: String?
    var name: String?
}

struct CatalogResponse: Codable {
    var tools: [ToolInfo]
    var disabledTools: [String]
    var prompts: [PromptInfo]
    var resources: [ResourceInfo]
    var resourceTemplates: [ResourceInfo]
    var instructions: String?
}

struct LogLine: Codable, Hashable, Identifiable {
    var ts: Double
    var stream: String
    var text: String
    var id: String { "\(ts)-\(text.hashValue)" }
}

struct PresetField: Codable, Hashable, Identifiable {
    var key: String
    var label: String
    var type: String
    var required: Bool?
    var `default`: JSONValue?
    var placeholder: String?
    var help: String?
    var options: [String]?
    var id: String { key }
}

struct Preset: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var provider: String
    var category: String
    var description: String
    var homepage: String
    var runtime: String
    var transport: String
    var command: String?
    var args: [JSONValue]?
    var url: String?
    var fields: [PresetField]
    var notes: String?
}

struct HubEntry: Codable, Hashable {
    var name: String
    var url: String
    var token: String?
}

struct ClientInfo: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var configPath: String
    var detected: Bool
    var connected: Bool
    var auto: Bool?
    var servers: [String]
    var snippet: String
    var note: String?
}

struct ClientsResponse: Codable {
    var entry: HubEntry
    var clients: [ClientInfo]
}

struct Candidate: Codable, Identifiable, Hashable {
    var sourceName: String
    var def: ServerDef?
    var error: String?
    var id: String { sourceName }
}

struct AppSettings: Codable, Hashable {
    var port: Int
    var hosts: [String]
    var token: String
    var requireTokenOnLoopback: Bool
    var clientEntryName: String
}

struct SessionInfo: Codable, Hashable {
    var id: String?
    var scope: String
    var client: String?
    var lastSeen: Double
    var attached: Bool?
}

struct AddressInfo: Codable, Hashable {
    var iface: String
    var address: String
    var tailscale: Bool
}

struct EngineStatus: Codable {
    var version: String
    var pid: Int
    var uptimeSec: Int
    var port: Int
    var hosts: [String]
    var dataDir: String
    var supervised: Bool
    var aggregateUrl: String
    var serverCount: Int
    var runningCount: Int
    var sessions: [SessionInfo]
    var runtimes: [String: String?]
    var cliPath: String
    var nodePath: String
    var shimPath: String
    var user: String
    var hostname: String
    var addresses: [AddressInfo]
}

struct ServiceStatus: Codable {
    var installed: Bool
    var running: Bool
    var pid: Int?
}

// MARK: - Response envelopes

struct ServersResponse: Codable { var servers: [ServerView] }
struct ServerResponse: Codable { var server: ServerView }
struct ServerDetailResponse: Codable { var server: ServerView; var def: ServerDef }
struct PresetsResponse: Codable { var presets: [Preset] }
struct LogsResponse: Codable { var logs: [LogLine] }
struct CandidatesResponse: Codable { var candidates: [Candidate] }
struct SettingsResponse: Codable { var settings: AppSettings; var restartRequired: Bool? }
struct BackupResponse: Codable { var ok: Bool; var backup: String? }
struct ImportResponse: Codable {
    struct Failure: Codable, Hashable { var id: String?; var error: String }
    var created: [ServerView]
    var errors: [Failure]
    var backup: String?
}
struct OKResponse: Codable { var ok: Bool }
