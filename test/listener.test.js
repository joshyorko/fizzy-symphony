import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

import { bindServerListener } from "../src/listener.js";
import { startLocalInstance } from "../src/instance-registry.js";
import { coordinationConfig, tempProject } from "./helpers.js";

test("fixed port collision fails before writing an instance registry file", async () => {
  const root = await tempProject("fizzy-symphony-fixed-collision-");
  const busy = await reservePortWithFreeNext();
  const config = coordinationConfig(root, {
    instance: { id: "fixed-instance" },
    server: {
      port: busy.port,
      port_allocation: "fixed",
      base_port: busy.port,
      registry_dir: join(root, "instances")
    }
  });

  try {
    await assert.rejects(
      () => startLocalInstance(config, { configPath: join(root, "config.json") }),
      (error) => error.code === "PORT_UNAVAILABLE" && error.details.port === busy.port
    );

    await assert.rejects(() => readdir(config.server.registry_dir), { code: "ENOENT" });
  } finally {
    await closeServer(busy.server);
  }
});

test("next_available scans from the configured base port and holds listener ownership", async () => {
  const root = await tempProject("fizzy-symphony-next-port-");
  const busy = await reservePortWithFreeNext();
  const config = coordinationConfig(root, {
    instance: { id: "next-instance" },
    server: {
      port: busy.port,
      port_allocation: "next_available",
      base_port: busy.port,
      registry_dir: join(root, "instances")
    }
  });

  let instance;
  try {
    instance = await startLocalInstance(config, { configPath: join(root, "config.json") });

    assert.equal(instance.endpoint.host, "127.0.0.1");
    assert.equal(instance.endpoint.port, busy.port + 1);
    await assertPortBusy(instance.endpoint.host, instance.endpoint.port);

    const registry = JSON.parse(await readFile(instance.registryPath, "utf8"));
    assert.equal(registry.instance_id, "next-instance");
    assert.equal(registry.port, busy.port + 1);
    assert.equal(registry.base_url, `http://127.0.0.1:${busy.port + 1}`);
  } finally {
    await instance?.cleanup();
    await closeServer(busy.server);
  }
});

test("random port allocation binds port zero and records the actual bound port", async () => {
  const root = await mkdtemp(join(tmpdir(), "fizzy-symphony-random-port-"));
  const config = coordinationConfig(root, {
    instance: { id: "random-instance" },
    server: {
      port: "auto",
      port_allocation: "random",
      registry_dir: join(root, "instances")
    }
  });

  const instance = await startLocalInstance(config, { configPath: join(root, "config.json") });
  try {
    assert.equal(instance.endpoint.host, "127.0.0.1");
    assert.ok(Number.isInteger(instance.endpoint.port));
    assert.ok(instance.endpoint.port > 0);

    const registry = JSON.parse(await readFile(instance.registryPath, "utf8"));
    assert.equal(registry.port, instance.endpoint.port);
    assert.equal(registry.base_url, `http://127.0.0.1:${instance.endpoint.port}`);
  } finally {
    await instance.cleanup();
  }
});

test("bindServerListener supports direct fixed bind-and-hold without registry side effects", async () => {
  const holder = await bindServerListener({
    host: "127.0.0.1",
    port: "auto",
    port_allocation: "random"
  });

  try {
    await assertPortBusy(holder.endpoint.host, holder.endpoint.port);
  } finally {
    await holder.close();
  }
});

async function reservePortWithFreeNext() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const server = await listenOn(0);
    const port = server.address().port;
    if (port >= 65535) {
      await closeServer(server);
      continue;
    }

    if (await canBind(port + 1)) {
      return { server, port };
    }
    await closeServer(server);
  }
  throw new Error("Unable to reserve a test port with an available next port.");
}

async function assertPortBusy(host, port) {
  await assert.rejects(() => listenOn(port, host), (error) => error.code === "EADDRINUSE");
}

async function canBind(port, host = "127.0.0.1") {
  try {
    const server = await listenOn(port, host);
    await closeServer(server);
    return true;
  } catch {
    return false;
  }
}

function listenOn(port, host = "127.0.0.1") {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port }, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

