import { describe, expect, test } from 'bun:test';

import { preprocessMarkdownContent } from './markdownPreprocess';

describe('preprocessMarkdownContent', () => {
  test('keeps C# language names inline instead of rewriting them as headings', () => {
    const input = '补充一下是： C# WPF + WebView2 架构';

    expect(preprocessMarkdownContent(input)).toBe(input);
  });

  test('keeps F# language names inline instead of rewriting them as headings', () => {
    const input = 'Use F# for this example';

    expect(preprocessMarkdownContent(input)).toBe(input);
  });

  test('still separates headings when marker is not attached to a word token', () => {
    expect(preprocessMarkdownContent('结果：# 标题')).toBe('结果：\n\n# 标题');
  });
});
