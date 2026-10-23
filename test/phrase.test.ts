import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@tesserax/sdk";
import { cleanSecret, phraseProblem } from "../src/lib/phrase";

// A test vector of BIP39.
const phrase =
  "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title";
const address = Keypair.fromUri(phrase).address;

test("phrases are accepted as people paste them", () => {
  const words = phrase.split(" ");
  for (const pasted of [
    words.join("\n"),
    `  ${words.join("   ")}  `,
    words.map((w) => w.toUpperCase()).join(" "),
    words.map((w, i) => `${i + 1}. ${w}`).join("\n"),
    words.map((w, i) => `${i + 1}) ${w}`).join(" "),
    words.join(", "),
  ]) {
    assert.equal(phraseProblem(pasted), null, pasted);
    assert.equal(Keypair.fromUri(cleanSecret(pasted)).address, address);
  }
  assert.equal(cleanSecret(`${phrase} //sudo`), `${phrase}//sudo`);
  assert.equal(Keypair.fromUri(cleanSecret(`${phrase}//sudo`)).address, Keypair.fromUri(`${phrase}//sudo`).address);
});

test("problems are named", () => {
  const words = phrase.split(" ");
  assert.match(phraseProblem([...words.slice(0, 22), "testo", "testa"].join(" "))!, /not in the list.*testo, testa/);
  assert.match(phraseProblem(words.slice(0, 20).join(" "))!, /^20 words/);
  const swapped = [...words];
  [swapped[0], swapped[23]] = [swapped[23], swapped[0]];
  assert.match(phraseProblem(swapped.join(" "))!, /a word is wrong or out of order/);
});
