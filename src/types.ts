export type Transport = 'stdio' | 'http';

/** A key/value pair (env var or HTTP header). Secret values are kept out of config.json. */
export interface KV {
  key: string;
  value: string;
  secret?: boolean;
}

export interface ServerDef {
  /** Slug used in URLs and tool prefixes: [a-z0-9-], no underscores. */
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  transport: Transport;
  // stdio
  command?: string;
  args?: string[];
  env?: KV[];
  cwd?: string;
  // http
  url?: string;
  headers?: KV[];
  /** Tools hidden from clients. */
  disabledTools?: string[];
  /** Tool arguments pinned by the hub: removed from every tool schema and always sent with this value. */
  fixedArgs?: KV[];
  presetId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Settings {
  port: number;
  /** Addresses to listen on. 127.0.0.1 is always included. */
  hosts: string[];
  /** Bearer token required for non-loopback requests. */
  token: string;
  requireTokenOnLoopback: boolean;
  /** Name used for the hub entry written into client configs. */
  clientEntryName: string;
}

export interface ConfigFile {
  version: 1;
  settings: Settings;
  servers: ServerDef[];
}

export type SecretsFile = Record<string, Record<string, string>>;

export type Status = 'stopped' | 'starting' | 'running' | 'error';

export interface LogLine {
  ts: number;
  stream: 'stderr' | 'system';
  text: string;
}
