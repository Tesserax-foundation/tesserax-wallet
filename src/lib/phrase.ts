/** Recovery phrases as people paste them: one word per line, numbered, in capitals. */

import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const WORD_COUNTS = [12, 15, 18, 21, 24];
const known = new Set(wordlist);

/** The phrase and the derivation path that may follow it (`//sudo`). */
function split(input: string): { words: string[]; path: string } {
  const text = input.trim();
  const at = text.indexOf("//");
  const words = (at === -1 ? text : text.slice(0, at))
    .normalize("NFKD")
    .toLowerCase()
    .split(/[\s,;]+/)
    // Numbered lists: "1. abandon", "1) abandon", "1 abandon".
    .filter((w) => w && !/^\d+[.)]?$/.test(w))
    .map((w) => w.replace(/^\d+[.)]/, ""));
  return { words, path: at === -1 ? "" : text.slice(at).replace(/\s+/g, "") };
}

/** The secret to derive the account from: the words separated by single spaces, then the path.
 * A hexadecimal seed is kept as it is. */
export function cleanSecret(input: string): string {
  if (input.trim().startsWith("0x")) return input.trim();
  const { words, path } = split(input);
  return words.join(" ") + path;
}

/** What is wrong with a phrase, or null if nothing is. */
export function phraseProblem(input: string): string | null {
  if (input.trim().startsWith("0x")) return null;
  const { words } = split(input);
  const unknown = words.filter((w) => !known.has(w));
  if (unknown.length) {
    const list = unknown.slice(0, 5).join(", ") + (unknown.length > 5 ? "…" : "");
    return `${unknown.length === 1 ? "This word is" : "These words are"} not in the list of recovery words: ${list}. Check the spelling.`;
  }
  if (!WORD_COUNTS.includes(words.length)) {
    return `${words.length} word${words.length === 1 ? "" : "s"}: a recovery phrase has 12, 15, 18, 21 or 24 words.`;
  }
  if (!validateMnemonic(words.join(" "), wordlist)) {
    return "The words are valid, but the phrase is not: a word is wrong or out of order. Check it against what you wrote down.";
  }
  return null;
}
