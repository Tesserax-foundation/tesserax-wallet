import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Keypair } from "@tesserax/sdk";
import { decrypt, encrypt, KeystoreError, parseKeystore, validName } from "../src/lib/keystore";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/cli-keystore.json", import.meta.url), "utf8"));
// The command line wallet, built in a checkout of the Tesserax repository.
const CLI = process.env.TESSERAX_WALLET_BIN ?? "../tesserax/target/debug/tesserax-wallet";

test("a keystore file of the command line wallet opens", async () => {
  const secret = await decrypt(parseKeystore(fixture), "cli password");
  assert.equal(Keypair.fromUri(secret).address, fixture.address);
  await assert.rejects(decrypt(fixture, "Cli password"), (e: KeystoreError) => e.kind === "wrong-password");
});

test("an edited address is detected", async () => {
  const edited = { ...fixture, address: Keypair.fromUri("//Bob").address };
  await assert.rejects(decrypt(edited, "cli password"), KeystoreError);
});

test("accounts encrypted here roundtrip", async () => {
  const { phrase, keypair } = Keypair.generate();
  const file = await encrypt("main", phrase, "a long password");
  assert.equal(file.address, keypair.address);
  assert.ok(!JSON.stringify(file).includes(phrase.split(" ")[0] + " "));
  assert.equal(await decrypt(file, "a long password"), phrase);
});

test("hostile files are refused before any key derivation", () => {
  assert.throws(() => parseKeystore({ ...fixture, kdf: { ...fixture.kdf, memory_kib: 4 * 1024 * 1024 } }), KeystoreError);
  assert.throws(() => parseKeystore({ ...fixture, kdf: { ...fixture.kdf, iterations: 1000 } }), KeystoreError);
  assert.throws(() => parseKeystore({ version: 2 }), KeystoreError);
  assert.ok(validName("agent-1") && !validName("../x") && !validName(""));
});

test("the command line wallet opens a file encrypted here", { skip: !existsSync(CLI) && "the command line wallet is not built" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "tesserax-wallet-"));
  try {
    const file = await encrypt("fromweb", "//Charlie", "web password");
    writeFileSync(join(dir, "fromweb.json"), JSON.stringify(file, null, 2));
    const out = execFileSync(CLI, ["account", "export", "fromweb"], {
      env: { ...process.env, TESSERAX_WALLET_DIR: dir, TESSERAX_PASSWORD: "web password" },
    }).toString();
    assert.equal(out.trim(), "//Charlie");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
