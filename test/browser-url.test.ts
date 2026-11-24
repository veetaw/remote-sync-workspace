import { expect, it } from 'vitest';
import { browserBaseUrl, browserFileUrl } from '../src/browser-url';

it('maps the project path to the configured website directory', () => {
  expect(browserFileUrl('https://example.com/app', '', 'pages/index.php')).toBe(
    'https://example.com/app/pages/index.php',
  );
  expect(
    browserFileUrl('https://example.com/', 'public', 'public/index.php'),
  ).toBe('https://example.com/index.php');
  expect(browserFileUrl('http://localhost:8080/', '', 'test.php')).toBe(
    'http://localhost:8080/test.php',
  );
});
it('encodes filename characters without turning them into URL syntax', () => {
  expect(
    browserFileUrl('https://example.com/', '', 'pagine/caffè #100%.php'),
  ).toBe('https://example.com/pagine/caff%C3%A8%20%23100%25.php');
});
it.each([
  'javascript:alert(1)',
  'file:///tmp/page.php',
  'ftp://example.com/',
  'https://user:secret@example.com/',
  'https://example.com/?action=remove',
  'https://example.com/#anchor',
  'example.com',
])('rejects an unsafe or ambiguous base URL: %s', (url) => {
  expect(() => browserBaseUrl(url)).toThrow();
});
it.each(['../outside.php', '/outside.php', 'public/../outside.php'])(
  'rejects a file path escaping the project: %s',
  (file) => {
    expect(() => browserFileUrl('https://example.com/', '', file)).toThrow();
  },
);
it('does not expose a file outside the configured web document root', () => {
  expect(() =>
    browserFileUrl('https://example.com/', 'public', 'config/secret.php'),
  ).toThrow('outside the configured web document root');
});
