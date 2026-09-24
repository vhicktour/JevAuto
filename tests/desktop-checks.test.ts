import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rtfBold, appearanceOf, answers, mentionsNumber } from '../evals/desktop/checks'

const BOLD = String.raw`{\rtf1\ansi\ansicpg1252\cocoartf2822
{\fonttbl\f0\fswiss\fcharset0 Helvetica-Bold;}
{\colortbl;\red255\green255\blue255;}
\pard\tx566\pardirnatural\partightenfactor0

\f0\b\fs24 \cf0 JevAuto wrote this paragraph.}`

test('rtfBold finds the text and reads its bold state from the nearest \\b or \\b0', () => {
  assert.deepEqual(rtfBold(BOLD, 'JevAuto wrote this paragraph.'), { found: true, bold: true })
  assert.deepEqual(rtfBold(BOLD.replace('\\b\\fs24', '\\b0\\fs24'), 'JevAuto wrote this paragraph.'), { found: true, bold: false })
  assert.deepEqual(rtfBold(BOLD, 'something else'), { found: false, bold: false })
  // \blue255 and \bin are other control words, never bold markers.
  assert.deepEqual(rtfBold(String.raw`{\colortbl;\red0\green0\blue255;}\f0 plain text}`, 'plain text'), { found: true, bold: false })
})

test('rtfBold falls back to a bold font face when no \\b is written', () => {
  const rtf = String.raw`{\rtf1{\fonttbl\f0\fswiss\fcharset0 Helvetica;\f1\fswiss\fcharset0 Helvetica-Bold;}\f1\fs24 Heavy words}`
  assert.deepEqual(rtfBold(rtf, 'Heavy words'), { found: true, bold: true })
})

test('the appearance comes from the global defaults', () => {
  assert.equal(appearanceOf('Dark', null), 'Dark')
  assert.equal(appearanceOf(null, null), 'Light')
  assert.equal(appearanceOf(null, '1'), 'Auto')
  assert.equal(appearanceOf('Dark', '1'), 'Auto')
})

test('an answer names the right option first', () => {
  assert.equal(answers('Your Mac uses the Dark appearance.', 'Dark', ['Light', 'Auto']), true)
  assert.equal(answers('It is Dark, not Light.', 'Dark', ['Light', 'Auto']), true)
  assert.equal(answers('It is Light.', 'Dark', ['Light', 'Auto']), false)
})

test('numbers are found with or without thousands separators, never inside other numbers', () => {
  assert.equal(mentionsNumber('The answer is 5,468.', 5468), true)
  assert.equal(mentionsNumber('= 5468', 5468), true)
  assert.equal(mentionsNumber('15468', 5468), false)
})
