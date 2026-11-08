import test from "node:test";
import assert from "node:assert/strict";
import { questionKeys } from "../features/ai/claudeTerminal.js";

const cor = { question: "Cor?", options: [{ label: "Azul" }, { label: "Verde" }] };
const frutas = { question: "Frutas?", multiSelect: true, options: [{ label: "Maçã" }, { label: "Uva" }, { label: "Pera" }] };

test("one single-select question submits on the digit", () => {
  assert.deepEqual(questionKeys([cor], { "Cor?": "Verde" }), ["2"]);
});

test("multiSelect toggles, moves on, then submits the review", () => {
  assert.deepEqual(questionKeys([cor, frutas], { "Cor?": "Verde", "Frutas?": "Maçã, Pera" }), ["2", "1", "3", "\x1b[C", "1"]);
});

test("a question with previews needs Enter after the digit", () => {
  const layout = { question: "Layout?", options: [{ label: "Top", preview: "x" }, { label: "Lista" }] };
  assert.deepEqual(questionKeys([layout, cor], { "Layout?": "Lista", "Cor?": "Azul" }), ["2", "\r", "1", "1"]);
});

test("a free-text answer has no key and stays in the TUI", () => {
  assert.equal(questionKeys([cor], { "Cor?": "Roxo" }), null);
});
