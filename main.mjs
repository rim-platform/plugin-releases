// node_modules/@rim-platform/plugin-sdk/dist/generated/protocol.js
var PROTOCOL_VERSION = 1;
var MAX_FRAME_BYTES = 4194304;
var ErrorCode = {
  /** the frame is not valid JSON. */
  PARSE_ERROR: -32700,
  /** the JSON is not a valid JSON-RPC 2.0 message. */
  INVALID_REQUEST: -32600,
  /** the receiver does not implement the method. */
  METHOD_NOT_FOUND: -32601,
  /** params are missing or have the wrong shape, including an unknown commandId. */
  INVALID_PARAMS: -32602,
  /** the receiver failed while handling a valid request. */
  INTERNAL_ERROR: -32603,
  /** the user has not approved the capability the method needs. */
  CAPABILITY_DENIED: -32e3,
  /** the plugin called a capability more often than its per-minute limit. */
  RATE_LIMITED: -32001,
  /** the plugin ran the command and it failed; message says why. */
  PLUGIN_ERROR: -32002
};
var Method = {
  handshake: "rim.handshake",
  heartbeat: "rim.heartbeat",
  shutdown: "rim.shutdown",
  principalChanged: "rim.principal.changed",
  principalsRemapped: "rim.principals.remapped",
  commandExecute: "rim.command.execute",
  log: "rim.log",
  settingsGet: "rim.settings.get",
  settingsChanged: "rim.settings.changed"
};

// node_modules/@rim-platform/plugin-sdk/dist/errors.js
var PluginError = class extends Error {
  /** JSON-RPC error code, one of {@link ErrorCode} or a code the plugin documents. */
  code;
  /** Optional machine-readable details, sent as `error.data`. Must be JSON. */
  data;
  constructor(message, options = {}) {
    super(message);
    this.name = "PluginError";
    this.code = options.code ?? ErrorCode.PLUGIN_ERROR;
    this.data = options.data;
  }
};
var HostRequestError = class extends Error {
  /** The method the plugin called. */
  method;
  /** JSON-RPC error code the host sent, such as `CAPABILITY_DENIED`. */
  code;
  /** `error.data` from the host, if any. */
  data;
  constructor(method, error) {
    super(`${method} failed (${error.code}): ${error.message}`);
    this.name = "HostRequestError";
    this.method = method;
    this.code = error.code;
    this.data = error.data;
  }
};
function toWireError(error, fallbackCode) {
  if (error instanceof PluginError) {
    const wireError = { code: error.code, message: error.message };
    if (error.data !== void 0)
      wireError.data = error.data;
    return wireError;
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: fallbackCode, message: message || "unknown error" };
}

// node_modules/@rim-platform/plugin-sdk/dist/framing.js
var HEADER_BYTES = 4;
var FrameTooLargeError = class extends Error {
  /** Length the frame claimed or would have had, in bytes. */
  length;
  constructor(length) {
    super(`frame of ${length} bytes is over the ${MAX_FRAME_BYTES}-byte limit`);
    this.name = "FrameTooLargeError";
    this.length = length;
  }
};
var encoder = new TextEncoder();
var decoder = new TextDecoder("utf-8", { fatal: true });
function encodeText(text) {
  const body = encoder.encode(text);
  if (body.length > MAX_FRAME_BYTES)
    throw new FrameTooLargeError(body.length);
  const frame = new Uint8Array(HEADER_BYTES + body.length);
  new DataView(frame.buffer).setUint32(0, body.length, true);
  frame.set(body, HEADER_BYTES);
  return frame;
}
var FrameDecoder = class {
  chunks = [];
  buffered = 0;
  /**
   * Add bytes from the stream and return every frame they complete, in order.
   * A frame whose body is not UTF-8 JSON comes back with `ok: false`; the
   * protocol says to log and drop it, and the stream stays usable.
   *
   * @throws FrameTooLargeError when a length prefix is over {@link MAX_FRAME_BYTES}.
   */
  push(chunk) {
    return this.pushBodies(chunk).map(parse);
  }
  /**
   * Add bytes from the stream and return the text of every frame they complete,
   * in order, or `null` for a frame whose body is not UTF-8.
   *
   * @throws FrameTooLargeError when a length prefix is over {@link MAX_FRAME_BYTES}.
   */
  pushText(chunk) {
    return this.pushBodies(chunk).map((body) => {
      try {
        return decoder.decode(body);
      } catch {
        return null;
      }
    });
  }
  pushBodies(chunk) {
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
    const frames = [];
    while (this.buffered >= HEADER_BYTES) {
      const header = this.peek(HEADER_BYTES);
      const length = new DataView(header.buffer, header.byteOffset, HEADER_BYTES).getUint32(0, true);
      if (length > MAX_FRAME_BYTES)
        throw new FrameTooLargeError(length);
      if (this.buffered < HEADER_BYTES + length)
        break;
      frames.push(this.take(HEADER_BYTES + length).subarray(HEADER_BYTES));
    }
    return frames;
  }
  /** Bytes received that do not make up a whole frame yet. */
  get pendingBytes() {
    return this.buffered;
  }
  peek(count) {
    if (this.chunks[0].length < count)
      this.chunks = [concat(this.chunks, this.buffered)];
    return this.chunks[0].subarray(0, count);
  }
  take(count) {
    const all = this.chunks.length === 1 ? this.chunks[0] : concat(this.chunks, this.buffered);
    this.chunks = all.length > count ? [all.subarray(count)] : [];
    this.buffered -= count;
    return all.subarray(0, count);
  }
};
function concat(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
function parse(body) {
  try {
    return { ok: true, value: JSON.parse(decoder.decode(body)) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// node_modules/@rim-platform/plugin-sdk/dist/manifest.js
function parseManifestInfo(text, source) {
  const raw = JSON.parse(text);
  if (typeof raw !== "object" || raw === null || typeof raw.plugin_id !== "string") {
    throw new Error(`${source} is not a plugin manifest: plugin_id is missing`);
  }
  const manifest = raw;
  const commands = /* @__PURE__ */ new Map();
  for (const entry of arrayOf(manifest.commands)) {
    if (typeof entry.id === "string")
      commands.set(entry.id, entry.dangerous === true);
  }
  const panelIds = /* @__PURE__ */ new Set();
  for (const entry of arrayOf(manifest.panels)) {
    if (typeof entry.id === "string")
      panelIds.add(entry.id);
  }
  return { pluginId: manifest.plugin_id, commands, panelIds };
}
function arrayOf(value) {
  if (!Array.isArray(value))
    return [];
  return value.filter((entry) => typeof entry === "object" && entry !== null);
}

// node_modules/@rim-platform/plugin-sdk/dist/principal.js
var MalformedPrincipalError = class extends Error {
  constructor(value) {
    super(`malformed principal: ${JSON.stringify(value)}`);
    this.name = "MalformedPrincipalError";
  }
};
function readPrincipal(value) {
  if (value === null)
    return null;
  if (typeof value !== "object" || Array.isArray(value))
    throw new MalformedPrincipalError(value);
  const { principalId, displayName } = value;
  if (typeof principalId !== "string" || principalId.length === 0) {
    throw new MalformedPrincipalError(value);
  }
  if (typeof displayName !== "string")
    throw new MalformedPrincipalError(value);
  return Object.freeze({ principalId, displayName });
}
var MalformedMappingError = class extends Error {
  constructor(value) {
    super(`malformed principal mapping: ${JSON.stringify(value)}`);
    this.name = "MalformedMappingError";
  }
};
function readPrincipalMappings(value) {
  if (!Array.isArray(value))
    throw new MalformedMappingError(value);
  return Object.freeze(value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new MalformedMappingError(item);
    }
    const { from, to } = item;
    if (typeof from !== "string" || from.length === 0 || typeof to !== "string" || to.length === 0) {
      throw new MalformedMappingError(item);
    }
    return Object.freeze({ from, to });
  }));
}
function samePrincipal(a, b) {
  if (a === null || b === null)
    return a === b;
  return a.principalId === b.principalId && a.displayName === b.displayName;
}

// node_modules/@rim-platform/plugin-sdk/dist/transport.js
var encoder2 = new TextEncoder();
function streamTransport(input, output) {
  return {
    messages: (async function* () {
      const decoder2 = new FrameDecoder();
      for await (const chunk of input) {
        for (const frame of decoder2.pushText(typeof chunk === "string" ? encoder2.encode(chunk) : chunk)) {
          yield frame ?? "";
        }
      }
    })(),
    send(text) {
      output.write(encodeText(text));
    },
    /** Resolves once everything written before it has been handed to the stream. */
    flush() {
      return new Promise((done) => output.write(new Uint8Array(0), () => done()));
    },
    close() {
    }
  };
}
function portTransport(port) {
  const queue = [];
  let wake = null;
  let closed = false;
  let failure = null;
  port.onmessage = (event) => {
    if (closed)
      return;
    const data = typeof event.data === "string" ? event.data : "";
    const bytes = data.length > MAX_FRAME_BYTES ? data.length : encoder2.encode(data).length;
    if (bytes > MAX_FRAME_BYTES) {
      failure = new FrameTooLargeError(bytes);
      closed = true;
    } else {
      queue.push(data);
    }
    wake?.();
  };
  const events = port;
  events.addEventListener?.("close", () => {
    closed = true;
    wake?.();
  });
  return {
    messages: (async function* () {
      for (; ; ) {
        while (queue.length > 0)
          yield queue.shift();
        if (failure)
          throw failure;
        if (closed)
          return;
        await new Promise((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    })(),
    send(text) {
      const bytes = encoder2.encode(text).length;
      if (bytes > MAX_FRAME_BYTES)
        throw new FrameTooLargeError(bytes);
      port.postMessage(text);
    },
    close() {
      closed = true;
      port.onmessage = null;
      port.close();
      wake?.();
    }
  };
}

// node_modules/@rim-platform/plugin-sdk/dist/plugin.js
var SUPPORTED_VERSIONS = Object.freeze([PROTOCOL_VERSION]);
var DEFAULT_REQUEST_TIMEOUT_MS = 3e4;
var UPDATE_PANEL_METHOD = "rim.ui.update_panel";
var STORAGE_GET_METHOD = "rim.storage.get";
var STORAGE_SET_METHOD = "rim.storage.set";
var CHAT_LIST_MESSAGES_METHOD = "rim.chat.list_messages";
var CHAT_GET_MESSAGE_METHOD = "rim.chat.get_message";
var CHAT_SEARCH_MESSAGES_METHOD = "rim.chat.search_messages";
var CHAT_POST_MESSAGE_METHOD = "rim.chat.post_message";
function createDefinePlugin(platform) {
  return (definition) => definePluginOn(platform, definition);
}
function definePluginOn(platform, definition) {
  if (typeof definition.id !== "string" || definition.id.length === 0) {
    throw new TypeError("definePlugin: id must be the plugin_id from rim-plugin.json");
  }
  const commands = /* @__PURE__ */ new Map();
  for (const [id, command] of Object.entries(definition.commands ?? {})) {
    if (typeof command?.run !== "function") {
      throw new TypeError(`definePlugin: command ${id} needs a run function`);
    }
    commands.set(id, command);
  }
  return Object.freeze({
    id: definition.id,
    run: (options = {}) => runPlugin(platform, definition, commands, options)
  });
}
async function runPlugin(platform, definition, commands, options) {
  const port = globalThis.rimPluginPort;
  const onStreams = options.input === void 0 && options.output === void 0;
  let transport;
  let exit = options.exit;
  if (options.transport) {
    transport = options.transport;
  } else if (port && onStreams) {
    transport = portTransport(port);
  } else {
    const streams = options.input === void 0 || options.output === void 0 ? platform.streams() : void 0;
    transport = streamTransport(options.input ?? streams.input, options.output ?? streams.output);
    if (onStreams)
      exit ??= platform.claimStdio();
  }
  const session = new Session(definition, commands, (text) => transport.send(text), loadManifest(platform, options.manifestPath), options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, platform);
  let code = 0;
  try {
    for await (const text of transport.messages) {
      session.receiveText(text);
      if (session.stopping)
        break;
    }
  } catch (error) {
    session.log("error", `connection failed: ${error instanceof Error ? error.message : error}`);
    code = error instanceof FrameTooLargeError ? 1 : 2;
  }
  await session.close();
  await transport.flush?.();
  transport.close();
  exit?.(code);
}
function loadManifest(platform, path) {
  if (path === false)
    return {};
  const text = globalThis.rimPluginManifest;
  const source = path ?? (typeof text === "string" ? "rimPluginManifest" : "rim-plugin.json");
  try {
    if (path === void 0 && typeof text === "string") {
      return { manifest: parseManifestInfo(text, source) };
    }
    return { manifest: platform.readManifest(source) };
  } catch (error) {
    return {
      problem: `cannot read ${source}: ${error instanceof Error ? error.message : error}`
    };
  }
}
var Session = class {
  stopping = false;
  host;
  definition;
  commands;
  send;
  platform;
  manifest;
  manifestProblem;
  requestTimeoutMs;
  pending = /* @__PURE__ */ new Map();
  nextRequestId = 1;
  ready = false;
  closed = false;
  hostVersion = "";
  protocolVersion = PROTOCOL_VERSION;
  grantedCapabilities = Object.freeze([]);
  principal = null;
  constructor(definition, commands, send, loaded, requestTimeoutMs, platform) {
    this.definition = definition;
    this.commands = commands;
    this.send = send;
    this.platform = platform;
    this.manifest = loaded.manifest;
    this.requestTimeoutMs = requestTimeoutMs;
    this.manifestProblem = loaded.problem ?? (loaded.manifest && loaded.manifest.pluginId !== definition.id ? `rim-plugin.json declares ${loaded.manifest.pluginId}, but the code defines ${definition.id}` : void 0);
    this.host = this.createHost();
    if (this.manifestProblem)
      this.log("error", this.manifestProblem);
    for (const id of this.manifest?.commands.keys() ?? []) {
      if (!commands.has(id))
        this.log("warn", `rim-plugin.json declares command ${id}, which has no handler`);
    }
    for (const id of commands.keys()) {
      if (this.manifest && !this.manifest.commands.has(id)) {
        this.log("warn", `command ${id} is not in rim-plugin.json, so the host never runs it`);
      }
    }
  }
  /** Handle the JSON text of one message from the host. */
  receiveText(text) {
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      this.log("warn", "dropped a message that is not JSON");
      return;
    }
    this.receive(frame);
  }
  /** Handle one parsed message from the host. */
  receive(frame) {
    if (!isRecord(frame) || frame.jsonrpc !== "2.0") {
      this.log("warn", "dropped a frame that is not JSON-RPC 2.0");
      return;
    }
    const { method, id } = frame;
    if (typeof method === "string") {
      if (id === void 0 || id === null)
        this.onNotification(method, frame.params);
      else if (isId(id))
        void this.onRequest(method, frame.params, id);
      else
        this.log("warn", `dropped ${method}: its id is neither a number nor a string`);
      return;
    }
    if (isId(id) && ("result" in frame || "error" in frame)) {
      this.onResponse(id, frame);
      return;
    }
    this.log("warn", "dropped a frame that is neither a request, a notification nor a response");
  }
  /** Write a line to the host log, or to stderr once the connection is closed. */
  log(level, message) {
    const frame = {
      jsonrpc: "2.0",
      method: Method.log,
      params: { level, message }
    };
    if (!this.closed) {
      try {
        this.write(frame);
        return;
      } catch {
      }
    }
    this.platform.stderr(`[${level}] ${message}`);
  }
  /** Run `onShutdown` and fail every request still waiting for the host. */
  async close() {
    if (this.closed)
      return;
    this.stopping = true;
    await this.callHook("onShutdown", () => this.definition.onShutdown?.());
    this.closed = true;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new HostRequestError(entry.method, {
        code: ErrorCode.INTERNAL_ERROR,
        message: "the connection to the host closed"
      }));
      this.pending.delete(id);
    }
  }
  async onRequest(method, params, id) {
    try {
      switch (method) {
        case Method.handshake: {
          const result = this.handshake(params);
          const response = { jsonrpc: "2.0", id, result };
          this.write(response);
          if (result.accepted) {
            await this.callHook("onReady", () => this.definition.onReady?.(this.host));
          }
          return;
        }
        case Method.heartbeat: {
          const response = { jsonrpc: "2.0", id, result: { pong: true } };
          this.write(response);
          return;
        }
        case Method.commandExecute: {
          let response;
          try {
            response = { jsonrpc: "2.0", id, result: await this.execute(params) };
          } catch (error) {
            response = { jsonrpc: "2.0", id, error: toWireError(error, ErrorCode.PLUGIN_ERROR) };
          }
          this.writeAnswer(response);
          return;
        }
        default:
          this.writeError(id, ErrorCode.METHOD_NOT_FOUND, `method not found: ${method}`);
      }
    } catch (error) {
      this.writeError(id, ErrorCode.INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
    }
  }
  onNotification(method, params) {
    if (method === Method.shutdown) {
      this.stopping = true;
    } else if (method === Method.principalChanged) {
      this.onPrincipalChanged(params);
    } else if (method === Method.principalsRemapped) {
      this.onPrincipalsRemapped(params);
    } else if (method === Method.settingsChanged) {
      this.onSettingsChanged(params);
    }
  }
  onResponse(id, frame) {
    const entry = typeof id === "number" ? this.pending.get(id) : void 0;
    if (!entry)
      return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (frame.error !== void 0)
      entry.reject(new HostRequestError(entry.method, readWireError(frame.error)));
    else
      entry.resolve(frame.result);
  }
  handshake(params) {
    const p = isRecord(params) ? params : {};
    const refuse = (error) => {
      this.log("error", `refused the handshake: ${error}`);
      return {
        accepted: false,
        protocolVersion: SUPPORTED_VERSIONS[0],
        pluginId: this.definition.id,
        error
      };
    };
    if (this.manifestProblem)
      return refuse(this.manifestProblem);
    if (p.pluginId !== this.definition.id) {
      return refuse(`this plugin is ${this.definition.id}, but the host started it as ${String(p.pluginId)}`);
    }
    const hostVersions = Array.isArray(p.supportedVersions) ? p.supportedVersions.filter(isVersion) : isVersion(p.protocolVersion) ? [p.protocolVersion] : [];
    const version = SUPPORTED_VERSIONS.find((v) => hostVersions.includes(v));
    if (version === void 0) {
      return refuse(`the host speaks protocol ${hostVersions.join(", ") || "(none)"}, this plugin speaks ${SUPPORTED_VERSIONS.join(", ")}`);
    }
    let principal = null;
    try {
      principal = readPrincipal(p.principal ?? null);
    } catch (error) {
      this.log("warn", `ignored the handshake principal: ${error.message}`);
    }
    this.principal = principal;
    this.protocolVersion = version;
    this.hostVersion = typeof p.hostVersion === "string" ? p.hostVersion : "";
    this.grantedCapabilities = Object.freeze(Array.isArray(p.grantedCapabilities) ? p.grantedCapabilities.filter((c) => typeof c === "string") : []);
    this.ready = true;
    return { accepted: true, protocolVersion: version, pluginId: this.definition.id };
  }
  async execute(params) {
    if (!this.ready) {
      throw new PluginError("rim.command.execute arrived before the handshake", {
        code: ErrorCode.INVALID_REQUEST
      });
    }
    const p = readExecuteParams(params);
    const command = this.commands.get(p.commandId);
    if (!command) {
      throw new PluginError(`unknown command: ${p.commandId}`, { code: ErrorCode.INVALID_PARAMS });
    }
    const dangerous = command.dangerous === true || this.manifest?.commands.get(p.commandId) === true;
    if (dangerous && !(p.confirmed === true && p.initiator === "user")) {
      throw new PluginError(`${p.commandId} is dangerous and runs only after the user confirms it`, {
        code: ErrorCode.PLUGIN_ERROR,
        data: { reason: "confirmation_required" }
      });
    }
    const context = Object.freeze({ ...p, host: this.host });
    return toCommandResult(p.commandId, await command.run(context));
  }
  onPrincipalChanged(params) {
    let principal;
    try {
      principal = readPrincipal(isRecord(params) ? params.principal : void 0);
    } catch (error) {
      this.log("warn", `ignored rim.principal.changed: ${error.message}`);
      return;
    }
    if (samePrincipal(principal, this.principal))
      return;
    this.principal = principal;
    void this.callHook("onPrincipalChanged", () => this.definition.onPrincipalChanged?.(principal, this.host));
  }
  onPrincipalsRemapped(params) {
    let mappings;
    try {
      mappings = readPrincipalMappings(isRecord(params) ? params.mappings : void 0);
    } catch (error) {
      this.log("warn", `ignored rim.principals.remapped: ${error.message}`);
      return;
    }
    if (mappings.length === 0)
      return;
    void this.callHook("onPrincipalsRemapped", () => this.definition.onPrincipalsRemapped?.(mappings, this.host));
  }
  onSettingsChanged(params) {
    const values = isRecord(params) ? params.values : void 0;
    if (!isRecord(values)) {
      this.log("warn", "ignored rim.settings.changed: values must be an object");
      return;
    }
    const settings = Object.freeze({ ...values });
    void this.callHook("onSettingsChanged", () => this.definition.onSettingsChanged?.(settings, this.host));
  }
  request(method, params) {
    if (this.closed || this.stopping || !this.ready) {
      const message = this.ready ? "the connection to the host is closing" : "the handshake has not finished";
      return Promise.reject(new HostRequestError(method, { code: ErrorCode.INTERNAL_ERROR, message }));
    }
    const id = this.nextRequestId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HostRequestError(method, {
          code: ErrorCode.INTERNAL_ERROR,
          message: `the host did not answer within ${this.requestTimeoutMs} ms`
        }));
      }, this.requestTimeoutMs);
      this.pending.set(id, { method, resolve: resolvePromise, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  async updatePanel(panelId, state, patch) {
    if (this.manifest && !this.manifest.panelIds.has(panelId)) {
      throw new PluginError(`panel ${panelId} is not declared in rim-plugin.json`, {
        code: ErrorCode.INVALID_PARAMS
      });
    }
    await this.request(UPDATE_PANEL_METHOD, { panel_id: panelId, state, patch });
  }
  createHost() {
    const session = this;
    return Object.freeze({
      pluginId: this.definition.id,
      get hostVersion() {
        return session.hostVersion;
      },
      get protocolVersion() {
        return session.protocolVersion;
      },
      get grantedCapabilities() {
        return session.grantedCapabilities;
      },
      get principal() {
        return session.principal;
      },
      log: Object.freeze({
        debug: (message) => session.log("debug", message),
        info: (message) => session.log("info", message),
        warn: (message) => session.log("warn", message),
        error: (message) => session.log("error", message)
      }),
      storage: Object.freeze({
        get: async (key) => {
          const result = await session.request(STORAGE_GET_METHOD, { key });
          return isRecord(result) && "value" in result ? result.value : null;
        },
        set: async (key, value) => {
          await session.request(STORAGE_SET_METHOD, { key, value });
        }
      }),
      settings: Object.freeze({
        get: async () => {
          const result = await session.request(Method.settingsGet, void 0);
          if (!isRecord(result) || !isRecord(result.values)) {
            throw new HostRequestError(Method.settingsGet, {
              code: ErrorCode.INTERNAL_ERROR,
              message: "the host answered without a values object"
            });
          }
          return Object.freeze({ ...result.values });
        }
      }),
      chat: Object.freeze({
        listMessages: async (conversationId, options = {}) => await session.request(CHAT_LIST_MESSAGES_METHOD, {
          conversationId,
          ...options
        }),
        getMessage: async (messageId) => {
          const result = await session.request(CHAT_GET_MESSAGE_METHOD, { messageId });
          return isRecord(result) && isRecord(result.message) ? result.message : null;
        },
        searchMessages: async (query, options = {}) => {
          const result = await session.request(CHAT_SEARCH_MESSAGES_METHOD, {
            query,
            ...options
          });
          return isRecord(result) && Array.isArray(result.messages) ? result.messages : [];
        },
        postMessage: async (conversationId, body, options = {}) => await session.request(CHAT_POST_MESSAGE_METHOD, {
          conversationId,
          body,
          ...options
        })
      }),
      panels: Object.freeze({
        set: (panelId, state) => session.updatePanel(panelId, state, false),
        patch: (panelId, patch) => {
          if (!isRecord(patch)) {
            return Promise.reject(new TypeError("panels.patch: patch must be an object"));
          }
          return session.updatePanel(panelId, patch, true);
        }
      })
    });
  }
  async callHook(name, hook) {
    try {
      await hook();
    } catch (error) {
      this.log("error", `${name} failed: ${error instanceof Error ? error.message : error}`);
    }
  }
  write(frame) {
    const text = JSON.stringify(frame);
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > MAX_FRAME_BYTES)
      throw new FrameTooLargeError(bytes);
    this.send(text);
  }
  /** Write a response, or an error saying why it could not be sent. */
  writeAnswer(response) {
    try {
      this.write(response);
    } catch (error) {
      this.writeError(response.id, ErrorCode.INTERNAL_ERROR, `could not send the result: ${error.message}`);
    }
  }
  writeError(id, code, message) {
    const response = { jsonrpc: "2.0", id, error: { code, message } };
    this.write(response);
  }
};
function readExecuteParams(params) {
  const invalid = (why) => new PluginError(`invalid rim.command.execute params: ${why}`, {
    code: ErrorCode.INVALID_PARAMS
  });
  if (!isRecord(params))
    throw invalid("params must be an object");
  const { commandId, args, invoker, initiator, confirmed } = params;
  if (typeof commandId !== "string" || commandId.length === 0)
    throw invalid("commandId must be a string");
  if (args !== void 0 && !isRecord(args))
    throw invalid("args must be an object");
  if (initiator !== "user" && initiator !== "agent")
    throw invalid("initiator must be user or agent");
  if (typeof confirmed !== "boolean")
    throw invalid("confirmed must be a boolean");
  let principal;
  try {
    principal = readPrincipal(invoker ?? null);
  } catch (error) {
    throw invalid(error.message);
  }
  return {
    commandId,
    args: Object.freeze({ ...args ?? {} }),
    invoker: principal,
    initiator,
    confirmed
  };
}
function toCommandResult(commandId, output) {
  if (output === void 0 || output === null)
    return {};
  if (typeof output !== "object" || Array.isArray(output)) {
    throw new PluginError(`command ${commandId} returned a ${typeof output}; return { payload, message }`, {
      code: ErrorCode.INTERNAL_ERROR
    });
  }
  const result = {};
  if (output.payload !== void 0)
    result.payload = output.payload;
  if (output.message !== void 0) {
    if (typeof output.message !== "string") {
      throw new PluginError(`command ${commandId} returned a message that is not a string`, {
        code: ErrorCode.INTERNAL_ERROR
      });
    }
    result.message = output.message;
  }
  return result;
}
function readWireError(value) {
  if (isRecord(value) && typeof value.code === "number" && typeof value.message === "string") {
    return { code: value.code, message: value.message, data: value.data };
  }
  return { code: ErrorCode.INTERNAL_ERROR, message: "the host sent a malformed error" };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isId(value) {
  return typeof value === "string" || typeof value === "number" && Number.isInteger(value);
}
function isVersion(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

// node_modules/@rim-platform/plugin-sdk/dist/index.browser.js
var browserPlatform = {
  streams() {
    throw new Error("this plugin runs in a RIM plugin frame, which has no stdio");
  },
  claimStdio() {
    return () => {
    };
  },
  readManifest: () => void 0,
  stderr: (line) => console.error(line)
};
var definePlugin = createDefinePlugin(browserPlatform);

// src/github.ts
var GitHubError = class extends Error {
  rateLimitedUntil;
  tokenRejected;
  constructor(message, rateLimitedUntil = null, tokenRejected = false) {
    super(message);
    this.name = "GitHubError";
    this.rateLimitedUntil = rateLimitedUntil;
    this.tokenRejected = tokenRejected;
  }
};
var TOKEN_SETTING_PLACE = "the plugin's settings (the Plugins menu \u2192 Releases Settings, or Settings \u2192 Plugins) in the desktop app";
function rateLimitMessage(credentials, at) {
  switch (credentials.kind) {
    case "token":
      return `GitHub refused: the requests an hour it allows with your token are used up. Try again after ${at}.`;
    case "locked":
      return `GitHub refused: the 60 requests an hour it allows without a token are used up, and the plugin could not read your GitHub token because the app's secret vault is locked; unlock your system keyring. Try again after ${at}.`;
    case "none":
      return `GitHub refused: the 60 requests an hour it allows without a token are used up. Try again after ${at}, or add a GitHub token in ${TOKEN_SETTING_PLACE}.`;
  }
}
var REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
function normalizeRepo(value) {
  if (typeof value !== "string") return null;
  const repo = value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/+$/, "");
  return REPO.test(repo) && !repo.endsWith(".git") ? repo : null;
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function firstLineOf(notes) {
  if (typeof notes !== "string") return "";
  for (const line of notes.split(/\r?\n/)) {
    const text = line.replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*)/, "").replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return "";
}
function releaseUrl(repo, tag, htmlUrl) {
  const prefix = `https://github.com/${repo}/releases/`;
  if (typeof htmlUrl === "string" && htmlUrl.toLowerCase().startsWith(prefix.toLowerCase()) && !/\s/.test(htmlUrl)) {
    return htmlUrl;
  }
  return `${prefix}tag/${encodeURIComponent(tag)}`;
}
function parseReleases(repo, body) {
  if (!Array.isArray(body))
    throw new GitHubError("GitHub sent something other than a list of releases.");
  return body.filter(isRecord2).filter((release) => release.draft !== true).filter((release) => typeof release.tag_name === "string" && release.tag_name.trim() !== "").map((release) => {
    const tag = String(release.tag_name).trim();
    return {
      tag,
      version: tag.replace(/^v(?=\d)/, ""),
      name: typeof release.name === "string" ? release.name.replace(/\s+/g, " ").trim() : "",
      firstLine: firstLineOf(release.body),
      url: releaseUrl(repo, tag, release.html_url),
      publishedAt: typeof release.published_at === "string" ? release.published_at : "",
      prerelease: release.prerelease === true
    };
  });
}
function clock(ms) {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
async function fetchReleases(repo, fetchImpl, credentials = { kind: "none" }) {
  const headers = { Accept: "application/vnd.github+json" };
  if (credentials.kind === "token") headers.Authorization = `Bearer ${credentials.token}`;
  let response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=5`, {
      headers
    });
  } catch {
    throw new GitHubError("GitHub could not be reached.");
  }
  if (response.ok) return parseReleases(repo, await response.json());
  const remaining = response.headers.get("x-ratelimit-remaining");
  if ((response.status === 403 || response.status === 429) && (remaining === "0" || response.status === 429)) {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    const until = Number.isFinite(reset) && reset > 0 ? reset * 1e3 : Date.now() + 60 * 60 * 1e3;
    throw new GitHubError(rateLimitMessage(credentials, clock(until)), until);
  }
  if (response.status === 401 && credentials.kind === "token") {
    throw new GitHubError(
      `GitHub rejected the token in the plugin's settings: it may have expired or been revoked. Replace it in ${TOKEN_SETTING_PLACE}.`,
      null,
      true
    );
  }
  if (response.status === 404) {
    throw new GitHubError(
      credentials.kind === "token" ? `${repo} was not found, or your token cannot read it.` : `${repo} was not found, or it is private.`
    );
  }
  throw new GitHubError(`GitHub answered ${response.status} for ${repo}.`);
}

// src/plugin.ts
var PLUGIN_ID = "chat.rim.releases";
var PANEL_ID = "releases";
var MAX_REPOS = 10;
var REFRESH_FLOOR_MS = 2 * 60 * 1e3;
var MAX_SUMMARY_LENGTH = 200;
var STORAGE_KEY = "repos";
var TOKEN_SETTING = "github_token";
var TOKEN = /^[\x21-\x7e]{1,1024}$/;
var DEFAULT_REPOS = [
  "rim-platform/rim-ui",
  "rim-platform/rim-server",
  "rim-platform/plugin-github-prs",
  "rim-platform/plugin-k8s-pods"
];
function clip(text, max) {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}\u2026`;
}
function summaryOf(release) {
  const named = release.name && release.name !== release.tag && release.name !== release.version;
  return clip((named ? release.name : release.firstLine).replace(/<@/g, "< @"), MAX_SUMMARY_LENGTH);
}
function releaseMessage(repo, release) {
  const name = repo.slice(repo.indexOf("/") + 1);
  const title = `\u{1F680} ${name} ${release.version} is out${release.prerelease ? " (pre-release)" : ""}`;
  const summary = summaryOf(release);
  return [title, ...summary ? [summary] : [], release.url].join("\n");
}
function postFailure(error, posted) {
  let text;
  let code = ErrorCode.PLUGIN_ERROR;
  if (error instanceof HostRequestError && error.code === ErrorCode.CAPABILITY_DENIED) {
    text = error.message.includes("encrypted") ? "This conversation is encrypted, and the plugin posts only in plaintext conversations." : "Posting needs the Send Chat Messages permission.";
    code = error.code;
  } else if (error instanceof HostRequestError && error.code === ErrorCode.RATE_LIMITED) {
    text = "The app allows 120 posts a minute; try again shortly.";
    code = error.code;
  } else {
    const reason = error instanceof Error ? error.message : String(error);
    text = `The app did not post the message: ${reason.replace(/^\S+ failed \(-?\d+\): /, "")}`;
    if (error instanceof HostRequestError) code = error.code;
  }
  return new PluginError(posted > 0 ? `${text} ${posted} posted before it.` : text, { code });
}
function secretsLocked(error) {
  return error instanceof HostRequestError && error.code === ErrorCode.INTERNAL_ERROR && typeof error.data === "object" && error.data !== null && error.data.reason === "secretsLocked";
}
function conversationOf(args) {
  const { conversation_id: conversationId, thread_id: threadId } = args;
  if (typeof conversationId !== "string" || conversationId.trim() === "") {
    throw new PluginError("Open a conversation to post releases into it.", {
      code: ErrorCode.INVALID_PARAMS
    });
  }
  if (threadId !== void 0 && threadId !== null && (typeof threadId !== "string" || !threadId)) {
    throw new PluginError("thread_id must be the id of the open thread.", {
      code: ErrorCode.INVALID_PARAMS
    });
  }
  return { conversationId, threadId: typeof threadId === "string" ? threadId : null };
}
function createPlugin(options = {}) {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  let repos = [];
  let signedIn = false;
  let fetchedAt = null;
  let token = null;
  let tokenLocked = false;
  let fetchedWith = null;
  let rateLimitedUntil = 0;
  let rateLimitedFor = null;
  let loading = false;
  let notice = null;
  let panelDenied = false;
  let fetching = Promise.resolve();
  let loaded = Promise.resolve();
  const state = () => ({
    repos,
    maxRepos: MAX_REPOS,
    fetchedAt: fetchedAt === null ? null : new Date(fetchedAt).toISOString(),
    loading,
    notice,
    signedIn
  });
  const credentials = () => token !== null ? { kind: "token", token } : { kind: tokenLocked ? "locked" : "none" };
  const rateLimited = () => now() < rateLimitedUntil && rateLimitedFor === token;
  function applySettings(values, host) {
    const saved = values[TOKEN_SETTING];
    const trimmed = typeof saved === "string" ? saved.trim() : "";
    token = TOKEN.test(trimmed) ? trimmed : null;
    if (trimmed !== "" && token === null) {
      host.log.warn("the GitHub token setting is not a token GitHub takes; asking without one");
    }
  }
  async function readSettings(host) {
    try {
      const values = await host.settings.get();
      tokenLocked = false;
      applySettings(values, host);
    } catch (error) {
      token = null;
      tokenLocked = secretsLocked(error);
      const unsupported = error instanceof HostRequestError && error.code === ErrorCode.METHOD_NOT_FOUND;
      if (tokenLocked) {
        host.log.warn("the GitHub token could not be read: the app's secret vault is locked");
      } else if (!unsupported) {
        host.log.warn(`could not read the settings: ${error.message}`);
      }
    }
  }
  const latest = () => repos.map((r) => ({ repo: r.repo, release: r.releases[0] ?? null, error: r.error }));
  async function publish(host) {
    if (panelDenied) return;
    try {
      await host.panels.set(PANEL_ID, state());
    } catch (error) {
      if (error instanceof HostRequestError && error.code === ErrorCode.CAPABILITY_DENIED) {
        panelDenied = true;
        host.log.warn("the panel needs the ui.panel permission");
        return;
      }
      host.log.warn(`could not update the panel: ${error.message}`);
    }
  }
  async function load(host) {
    signedIn = host.principal !== null;
    fetchedAt = null;
    notice = null;
    await readSettings(host);
    if (!signedIn) {
      repos = [];
      return;
    }
    try {
      const stored = await host.storage.get(STORAGE_KEY);
      const names = Array.isArray(stored) ? stored.map(normalizeRepo).filter((r) => r !== null) : [...DEFAULT_REPOS];
      repos = names.slice(0, MAX_REPOS).map((repo) => ({ repo, releases: [], error: null }));
    } catch (error) {
      repos = [];
      host.log.warn(`could not read the saved repositories: ${error.message}`);
    }
  }
  async function save(host) {
    await host.storage.set(
      STORAGE_KEY,
      repos.map((r) => r.repo)
    );
  }
  async function fetchRepos(host, targets) {
    if (rateLimited()) return;
    loading = true;
    await publish(host);
    const asked = credentials();
    for (const target of targets) {
      try {
        target.releases = await fetchReleases(target.repo, fetchImpl, asked);
        target.error = null;
      } catch (error) {
        const refusal = error instanceof GitHubError ? error : new GitHubError(String(error));
        if (refusal.rateLimitedUntil !== null) {
          rateLimitedUntil = refusal.rateLimitedUntil;
          rateLimitedFor = asked.kind === "token" ? asked.token : null;
          notice = refusal.message;
          break;
        }
        if (refusal.tokenRejected) {
          notice = refusal.message;
          break;
        }
        target.error = refusal.message;
      }
    }
    loading = false;
  }
  function fetchAll(host) {
    notice = null;
    fetchedAt = now();
    fetchedWith = token;
    fetching = fetchRepos(host, repos).then(() => publish(host));
    return fetching;
  }
  async function ensureFresh(host) {
    if (tokenLocked) await readSettings(host);
    if (repos.length === 0 || rateLimited()) return;
    if (fetchedAt !== null && now() - fetchedAt < REFRESH_FLOOR_MS) {
      await fetching;
      return;
    }
    await fetchAll(host);
  }
  async function refresh(host) {
    if (tokenLocked) await readSettings(host);
    if (repos.length === 0) {
      await publish(host);
      return "No repositories yet: add one in the panel.";
    }
    if (rateLimited()) {
      await publish(host);
      return notice ?? "GitHub refused; try again later.";
    }
    if (fetchedAt !== null && now() - fetchedAt < REFRESH_FLOOR_MS) {
      await fetching;
      notice = credentials().kind === "none" ? `Fetched less than 2 minutes ago. GitHub allows 60 requests an hour without a token; add one in ${TOKEN_SETTING_PLACE}.` : "Fetched less than 2 minutes ago.";
      await publish(host);
      return notice;
    }
    await fetchAll(host);
    const found = repos.filter((r) => r.releases.length > 0).length;
    return notice ?? `Latest releases of ${found} of ${repos.length} repositor${repos.length === 1 ? "y" : "ies"}`;
  }
  function repoArgument(args) {
    const repo = normalizeRepo(args.repo);
    if (!repo) {
      throw new PluginError("repo must be a repository as owner/name, such as rust-lang/rust", {
        code: ErrorCode.INVALID_PARAMS
      });
    }
    return repo;
  }
  function targetsOf(args) {
    if (args.repo === void 0 || args.repo === null || args.repo === "") return repos;
    const repo = repoArgument(args);
    const listed = repos.find((r) => r.repo.toLowerCase() === repo.toLowerCase());
    if (!listed) {
      throw new PluginError(`${repo} is not on the list; add it first.`, {
        code: ErrorCode.INVALID_PARAMS
      });
    }
    return [listed];
  }
  function requireSignIn() {
    if (!signedIn) throw new PluginError("Sign in to keep a list of repositories.");
  }
  return definePlugin({
    id: PLUGIN_ID,
    commands: {
      refresh: {
        async run({ host }) {
          await loaded;
          const message = await refresh(host);
          return { payload: state(), message };
        }
      },
      add_repo: {
        async run({ host, args }) {
          await loaded;
          requireSignIn();
          const repo = repoArgument(args);
          if (repos.some((r) => r.repo.toLowerCase() === repo.toLowerCase())) {
            return { payload: state(), message: `${repo} is already in the list` };
          }
          if (repos.length >= MAX_REPOS) {
            throw new PluginError(
              `The list holds at most ${MAX_REPOS} repositories; remove one first.`
            );
          }
          const added = { repo, releases: [], error: null };
          repos = [...repos, added];
          await save(host);
          await fetchRepos(host, [added]);
          await publish(host);
          return { payload: state(), message: added.error ?? notice ?? `Added ${repo}` };
        }
      },
      remove_repo: {
        async run({ host, args }) {
          await loaded;
          requireSignIn();
          const repo = repoArgument(args);
          repos = repos.filter((r) => r.repo.toLowerCase() !== repo.toLowerCase());
          await save(host);
          await publish(host);
          return { payload: state(), message: `Removed ${repo}` };
        }
      },
      "releases.post": {
        async run({ host, args }) {
          await loaded;
          const { conversationId, threadId } = conversationOf(args);
          requireSignIn();
          const targets = targetsOf(args);
          if (targets.length === 0) {
            throw new PluginError("No repositories yet: add one in the panel.");
          }
          await ensureFresh(host);
          const posted = [];
          const missing = [];
          for (const target of targets) {
            const release = target.releases[0];
            if (!release) {
              missing.push(target);
              continue;
            }
            try {
              const { id } = await host.chat.postMessage(
                conversationId,
                releaseMessage(target.repo, release),
                threadId === null ? {} : { threadId }
              );
              posted.push({ repo: target.repo, tag: release.tag, messageId: id });
            } catch (error) {
              throw postFailure(error, posted.length);
            }
          }
          const why = missing.map((r) => r.error ?? `${r.repo} has no published release.`);
          if (posted.length === 0) {
            throw new PluginError(`Nothing to post. ${notice ?? why.join(" ")}`);
          }
          const count = `Posted ${posted.length} release${posted.length === 1 ? "" : "s"}`;
          return {
            payload: { posted },
            message: missing.length === 0 ? count : `${count}. ${why.join(" ")}`
          };
        }
      },
      "releases.latest": {
        async run({ host }) {
          await loaded;
          await ensureFresh(host);
          await publish(host);
          const message = notice ?? `Latest releases of ${repos.length} repositor${repos.length === 1 ? "y" : "ies"}`;
          return { payload: latest(), message };
        }
      }
    },
    async onReady(host) {
      loaded = load(host);
      await loaded;
      await refresh(host);
    },
    async onPrincipalChanged(_principal, host) {
      loaded = load(host);
      await loaded;
      await refresh(host);
    },
    // The user saved or reset the settings, or another account signed in: a list
    // fetched with another token is fetched again with this one.
    async onSettingsChanged(values, host) {
      tokenLocked = false;
      applySettings(values, host);
      await loaded;
      await fetching;
      if (fetchedAt === null || fetchedWith === token || repos.length === 0) return;
      await fetchAll(host);
    }
  });
}

// src/main.ts
await createPlugin().run();
