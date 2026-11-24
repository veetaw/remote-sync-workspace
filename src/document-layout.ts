/** Find the document's HTML element outside PHP code and HTML comments. */
export function htmlStartOffset(text: string): number | undefined {
  let php = false;
  let quote = '';
  let comment: 'line' | 'block' | undefined;
  let heredoc: string | undefined;
  for (let i = 0; i < text.length; i++) {
    if (!php) {
      if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4);
        if (end < 0) return;
        i = end + 2;
        continue;
      }
      if (
        text.startsWith('<?', i) &&
        !/^<\?xml\b/i.test(text.slice(i, i + 8))
      ) {
        php = true;
        i++;
        continue;
      }
      if (/^<html(?=[\s>])/i.test(text.slice(i, i + 6))) return i;
      continue;
    }
    if (heredoc) {
      if (i === 0 || text[i - 1] === '\n') {
        const end = new RegExp(`^[ \\t]*${heredoc}(?![a-zA-Z0-9_])`).exec(
          text.slice(i),
        );
        if (end) {
          heredoc = undefined;
          i += end[0].length - 1;
        }
      }
      continue;
    }
    if (quote) {
      if (text[i] === '\\') i++;
      else if (text[i] === quote) quote = '';
      continue;
    }
    if (comment === 'block') {
      if (text.startsWith('*/', i)) {
        comment = undefined;
        i++;
      }
      continue;
    }
    if (text.startsWith('?>', i)) {
      php = false;
      comment = undefined;
      i++;
      continue;
    }
    if (comment === 'line') {
      if (text[i] === '\n') comment = undefined;
      continue;
    }
    if (text.startsWith('/*', i)) {
      comment = 'block';
      i++;
      continue;
    }
    if (text.startsWith('//', i) || text[i] === '#') {
      comment = 'line';
      continue;
    }
    if (['"', "'", '`'].includes(text[i])) {
      quote = text[i];
      continue;
    }
    if (text.startsWith('<<<', i)) {
      const start =
        /^<<<[ \t]*(['"]?)([a-zA-Z_][a-zA-Z0-9_]*)\1[^\r\n]*\r?\n/.exec(
          text.slice(i),
        );
      if (start) {
        heredoc = start[2];
        i += start[0].length - 1;
      }
    }
  }
}
