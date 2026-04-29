const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_PATTERN = /(?:token|secret|password|credential|api[-_]?key|apikey|authorization|cookie|signature)/iu;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gu;

export function createLogger(options = {}) {
  const {
    context = {},
    writer = process.stdout,
    now = () => new Date().toISOString()
  } = options;

  const baseContext = contextFields(context);

  function log(level, event, fields = {}) {
    const record = redact({
      timestamp: toTimestamp(now),
      level,
      event,
      ...baseContext,
      ...fields
    });
    writeLine(writer, `${JSON.stringify(omitUndefined(record))}\n`);
    return record;
  }

  return {
    debug: (event, fields) => log("debug", event, fields),
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
    child: (childContext = {}) => createLogger({
      ...options,
      context: {
        ...context,
        ...childContext
      }
    })
  };
}

export function redact(value, key = "") {
  if (isSensitiveKey(key)) return REDACTED;

  if (typeof value === "string") {
    return value.replace(BEARER_PATTERN, "Bearer [REDACTED]");
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry));
  }

  if (value instanceof Error) {
    return redact({
      name: value.name,
      message: value.message,
      code: value.code,
      details: value.details
    });
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redact(entryValue, entryKey)])
    );
  }

  return value;
}

function contextFields(context) {
  const run = context.run ?? {};
  const card = context.card ?? {};
  const route = context.route ?? {};
  const workspace = context.workspace ?? {};
  const runner = context.runner ?? {};

  return omitUndefined({
    instance_id: context.instance_id ?? context.instance?.id,
    run_id: context.run_id ?? run.id ?? run.run_id,
    attempt_id: context.attempt_id ?? run.attempt_id ?? context.attempt?.id,
    card_id: context.card_id ?? card.id,
    card_number: context.card_number ?? card.number,
    route_id: context.route_id ?? route.id,
    route_fingerprint: context.route_fingerprint ?? route.fingerprint,
    workspace_key: context.workspace_key ?? workspace.key,
    workspace_path: context.workspace_path ?? workspace.path,
    runner_kind: context.runner_kind ?? runner.kind
  });
}

function writeLine(writer, line) {
  if (typeof writer === "function") {
    writer(line);
  } else {
    writer.write(line);
  }
}

function isSensitiveKey(key) {
  return SENSITIVE_KEY_PATTERN.test(String(key));
}

function toTimestamp(now) {
  const value = typeof now === "function" ? now() : now;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function omitUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
