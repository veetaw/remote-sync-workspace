import { describe, expect, it } from 'vitest';
import { htmlStartOffset } from '../src/document-layout';
import { comparisonState } from '../src/file-comparison';

describe('PHP / HTML reading layout', () => {
  it.each([
    '<?php echo 1; ?>\n<html>real',
    '<?php $x="<html>fake ?>"; ?>\n<HTML lang="it">real',
    '<?php /* <html>fake ?> */ echo 1; ?>\n<html>real',
    '<?php // <html>fake\n ?>\n<html>real',
    '<!-- <html>fake -->\n<html>real',
    '<?php $x = <<<HTML\n<html>fake\nHTML;\n?>\n<html>real',
    "<?php $x = <<<'HTML'\n<html>fake\n  HTML;\n?>\n<html>real",
    '<?php $x=`<html>fake`; ?>\n<html>real',
  ])('finds the real HTML element outside PHP and comments', (text) => {
    expect(htmlStartOffset(text)).toBe(
      text.indexOf('real') -
        (text.includes('lang="it"')
          ? '<HTML lang="it">'.length
          : '<html>'.length),
    );
  });
  it.each([
    '<?php echo "<html>fake";',
    '<htmlish>nothing',
    '<!-- <html>fake',
    '<?xml version="1.0"?>',
  ])('handles a document with no HTML element', (text) => {
    expect(htmlStartOffset(text)).toBeUndefined();
  });
});
describe('current-file divergence indicator', () => {
  it.each([
    ['base', 'base', false, 'synced'],
    ['base', 'base', true, 'local'],
    ['changed', 'base', false, 'local'],
    ['base', 'changed', false, 'remote'],
    ['base', 'changed', true, 'conflict'],
    ['local', 'remote', false, 'conflict'],
    ['same-new', 'same-new', false, 'synced'],
    ['base', null, false, 'remote'],
  ] as const)(
    'classifies local=%s remote=%s dirty=%s as %s',
    (local, remote, dirty, expected) => {
      expect(
        comparisonState(
          { local, remote, baseline: 'base', checkedAt: 'now' },
          dirty,
        ),
      ).toBe(expected);
    },
  );
});
