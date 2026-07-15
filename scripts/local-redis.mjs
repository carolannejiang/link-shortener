// A tiny in-memory stand-in for Upstash Redis's REST API, so `npm run dev`
// works without a real database. Implements only the commands this app uses.
// Data lives in this process — restart it and everything resets.
//
//   node scripts/local-redis.mjs        # listens on http://127.0.0.1:8079
//
// Point .env.local at it:
//   KV_REST_API_URL=http://127.0.0.1:8079
//   KV_REST_API_TOKEN=anything

import http from "node:http";
import { pathToFileURL } from "node:url";

const PORT = Number(process.env.PORT ?? 8079);

// key → { type, v, expireAt? }  (v: string | Map | Set | Array)
const store = new Map();

function get(key) {
  const e = store.get(key);
  if (!e) return null;
  if (e.expireAt && e.expireAt <= Date.now()) {
    store.delete(key);
    return null;
  }
  return e;
}

function ensure(key, type, init) {
  let e = get(key);
  if (!e) {
    e = { type, v: init() };
    store.set(key, e);
  }
  return e;
}

function range(arr, start, stop) {
  const len = arr.length;
  let s = Number(start), t = Number(stop);
  if (s < 0) s += len;
  if (t < 0) t += len;
  return arr.slice(Math.max(0, s), t + 1);
}

function exec([cmd, ...args]) {
  switch (String(cmd).toUpperCase()) {
    case "PING":
      return "PONG";
    case "GET":
      return get(args[0])?.v ?? null;
    case "SET": {
      const [key, value, ...opts] = args;
      const e = { type: "string", v: String(value) };
      for (let i = 0; i < opts.length; i += 2) {
        if (String(opts[i]).toUpperCase() === "EX")
          e.expireAt = Date.now() + Number(opts[i + 1]) * 1000;
      }
      store.set(key, e);
      return "OK";
    }
    case "GETEX": {
      const [key, ...opts] = args;
      const e = get(key);
      if (!e) return null;
      for (let i = 0; i < opts.length; i += 2) {
        if (String(opts[i]).toUpperCase() === "EX")
          e.expireAt = Date.now() + Number(opts[i + 1]) * 1000;
      }
      return e.v;
    }
    case "GETDEL": {
      const e = get(args[0]);
      if (!e) return null;
      store.delete(args[0]);
      return e.v;
    }
    case "DEL": {
      let n = 0;
      for (const key of args) if (get(key)) { store.delete(key); n++; }
      return n;
    }
    case "EXISTS": {
      let n = 0;
      for (const key of args) if (get(key)) n++;
      return n;
    }
    case "EXPIRE": {
      const e = get(args[0]);
      if (!e) return 0;
      e.expireAt = Date.now() + Number(args[1]) * 1000;
      return 1;
    }
    case "INCR": {
      const e = ensure(args[0], "string", () => "0");
      e.v = String(Number(e.v) + 1);
      return Number(e.v);
    }
    case "HSET": {
      const e = ensure(args[0], "hash", () => new Map());
      let added = 0;
      for (let i = 1; i < args.length; i += 2) {
        if (!e.v.has(args[i])) added++;
        e.v.set(args[i], args[i + 1]);
      }
      return added;
    }
    case "HGET":
      return get(args[0])?.v.get(args[1]) ?? null;
    case "HGETALL": {
      const e = get(args[0]);
      if (!e) return [];
      const flat = [];
      for (const [f, v] of e.v) flat.push(f, v);
      return flat;
    }
    case "HDEL": {
      const e = get(args[0]);
      if (!e) return 0;
      let n = 0;
      for (const f of args.slice(1)) if (e.v.delete(f)) n++;
      return n;
    }
    case "HEXISTS":
      return get(args[0])?.v.has(args[1]) ? 1 : 0;
    case "HLEN":
      return get(args[0])?.v.size ?? 0;
    case "HINCRBY": {
      const e = ensure(args[0], "hash", () => new Map());
      const next = Number(e.v.get(args[1]) ?? 0) + Number(args[2]);
      e.v.set(args[1], String(next));
      return next;
    }
    case "SADD": {
      const e = ensure(args[0], "set", () => new Set());
      let n = 0;
      for (const m of args.slice(1)) if (!e.v.has(m)) { e.v.add(m); n++; }
      return n;
    }
    case "SREM": {
      const e = get(args[0]);
      if (!e) return 0;
      let n = 0;
      for (const m of args.slice(1)) if (e.v.delete(m)) n++;
      return n;
    }
    case "SISMEMBER":
      return get(args[0])?.v.has(args[1]) ? 1 : 0;
    case "SMEMBERS": {
      const e = get(args[0]);
      return e ? [...e.v] : [];
    }
    case "LPUSH": {
      const e = ensure(args[0], "list", () => []);
      for (const v of args.slice(1)) e.v.unshift(v);
      return e.v.length;
    }
    case "LRANGE": {
      const e = get(args[0]);
      return e ? range(e.v, args[1], args[2]) : [];
    }
    case "LTRIM": {
      const e = get(args[0]);
      if (e) e.v = range(e.v, args[1], args[2]);
      return "OK";
    }
    default:
      throw new Error(`local-redis: unsupported command ${cmd}`);
  }
}

// The client asks for base64-encoded responses (Upstash-Encoding: base64)
// and decodes them; encode every string result except the literal "OK",
// mirroring the real API.
function encode(x) {
  if (typeof x === "string" && x !== "OK")
    return Buffer.from(x).toString("base64");
  if (Array.isArray(x)) return x.map(encode);
  return x;
}

// The unit tests import this to run the same shim on an ephemeral port.
export function createLocalRedis() {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      const wantB64 = req.headers["upstash-encoding"] === "base64";
      const wrap = (x) => (wantB64 ? encode(x) : x);
      try {
        const payload = JSON.parse(body || "[]");
        if (req.url?.startsWith("/pipeline") || req.url?.startsWith("/multi-exec")) {
          const results = payload.map((cmd) => {
            try {
              return { result: wrap(exec(cmd)) };
            } catch (err) {
              return { error: String(err.message ?? err) };
            }
          });
          res.end(JSON.stringify(results));
        } else {
          res.end(JSON.stringify({ result: wrap(exec(payload)) }));
        }
      } catch (err) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: String(err.message ?? err) }));
      }
    });
  });
}

// Started directly (`node scripts/local-redis.mjs`) → serve on the fixed port.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createLocalRedis().listen(PORT, "127.0.0.1", () => {
    console.log(`local-redis shim listening on http://127.0.0.1:${PORT}`);
  });
}
