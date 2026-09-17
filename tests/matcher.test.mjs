// Unit tests for the matching engine: node tests/matcher.test.mjs
import {
  findMatch,
  hostMatches,
  urlMatches,
  keywordMatches,
  isWipeableUrl,
  hostOf,
  hasNestedQuantifier,
  isRunnableRegex,
  skippedRegexes,
  resetSkippedRegexes,
  REGEX_MAX_PATTERN,
  REGEX_MAX_TEXT,
} from '../matcher.js';
import { buildRule, normalizeDomain } from '../store.js';

let pass = 0;
let fail = 0;

function ok(label, actual, expected) {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  if (good) {
    pass++;
  } else {
    fail++;
    console.log(`  FAIL ${label}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
  }
}

const domain = (value, includeSubdomains = false) => ({ id: 'd', type: 'domain', value, includeSubdomains, enabled: true });
const keyword = (value, wholeWord = false) => ({ id: 'k', type: 'keyword', value, wholeWord, enabled: true });
const url = (value) => ({ id: 'u', type: 'url', value, enabled: true });
const regex = (value) => ({ id: 'x', type: 'regex', value, enabled: true });

console.log('domain matching');
ok('hostOf strips www', hostOf('https://www.example.com/a'), 'example.com');
ok('exact domain', hostMatches('example.com', 'example.com', false), true);
ok('www counts as the same site', hostMatches('www.example.com', 'example.com', false), true);
ok('subdomain blocked when off', hostMatches('shop.example.com', 'example.com', false), false);
ok('subdomain blocked when on', hostMatches('shop.example.com', 'example.com', true), true);
ok('deep subdomain', hostMatches('a.b.c.example.com', 'example.com', true), true);
ok('lookalike domain rejected', hostMatches('notexample.com', 'example.com', true), false);
ok('suffix attack rejected', hostMatches('example.com.evil.io', 'example.com', true), false);

console.log('url matching');
ok('exact url', urlMatches('https://example.com/app', 'https://example.com/app'), true);
ok('trailing slash tolerated', urlMatches('https://example.com/app/', 'https://example.com/app'), true);
ok('query counts as prefix', urlMatches('https://example.com/app?x=1', 'https://example.com/app'), true);
ok('path continuation counts', urlMatches('https://example.com/app/sub', 'https://example.com/app'), true);
ok('partial path word does not', urlMatches('https://example.com/application', 'https://example.com/app'), false);
ok('different host does not', urlMatches('https://other.com/app', 'https://example.com/app'), false);
ok('scheme/host case folded', urlMatches('https://Example.com/App', 'HTTPS://example.com/App'), true);

console.log('keyword matching');
ok('substring in url', keywordMatches('https://www.google.com/search?q=shoes', 'shoes', false), true);
ok('substring in title', keywordMatches('shoes - Google Search', 'shoes', false), true);
ok('case insensitive', keywordMatches('Shoes', 'shoes', false), true);
ok('mdn documented substring', keywordMatches('Example Domain', 'main', false), true);
ok('whole word: no partial hit', keywordMatches('https://shoeshine.com', 'shoes', true), false);
ok('whole word: real hit', keywordMatches('buy shoes now', 'shoes', true), true);
ok('whole word at string end', keywordMatches('cheap shoes', 'shoes', true), true);

console.log('rule dispatch + guards');
ok('domain rule via findMatch', !!findMatch({ url: 'https://shop.example.com/x', title: '' }, [domain('example.com', true)]), true);
ok('keyword rule hits title', !!findMatch({ url: 'https://x.com/q', title: 'shoes - Google Search' }, [keyword('shoes')]), true);
ok('url prefix rule', !!findMatch({ url: 'https://example.com/private/1', title: '' }, [url('https://example.com/private')]), true);
ok('regex rule', !!findMatch({ url: 'https://translate.google.com/?text=hi', title: '' }, [regex('^https://translate\\.google\\.[^/]+/')]), true);
ok('disabled rule skipped', findMatch({ url: 'https://example.com' }, [{ ...domain('example.com'), enabled: false }]), null);
ok('chrome:// never touched', findMatch({ url: 'chrome://settings', title: 'example.com' }, [keyword('example.com')]), null);
ok('extension pages never touched', findMatch({ url: 'chrome-extension://abc/options.html', title: 'x' }, [keyword('x')]), null);
ok('no rules, no match', findMatch({ url: 'https://example.com' }, []), null);
ok('first match wins', findMatch({ url: 'https://example.com' }, [domain('example.com'), keyword('example')]).id, 'd');
ok('wipeable scheme check', [isWipeableUrl('https://a.com'), isWipeableUrl('ftp://a.com'), isWipeableUrl('chrome://x'), isWipeableUrl(undefined)], [true, true, false, false]);

console.log('rule building (store.js)');
ok('normalizeDomain on a full url', normalizeDomain('https://WWW.Example.com/path?q=1'), 'example.com');
ok('domain rule rejects garbage', buildRule({ type: 'domain', value: 'not a domain' }).ok, false);
ok('domain rule requires a dot', buildRule({ type: 'domain', value: 'localhost' }).ok, true);
const dr = buildRule({ type: 'domain', value: 'https://www.Example.com/foo', includeSubdomains: true });
ok('domain rule normalizes value', dr.rule.value, 'example.com');
ok('domain rule keeps subdomain flag', dr.rule.includeSubdomains, true);
ok('url rule needs a scheme', buildRule({ type: 'url', value: 'example.com/x' }).ok, false);
ok('url rule accepts https', buildRule({ type: 'url', value: 'https://example.com/x' }).ok, true);
ok('keyword rule min length', buildRule({ type: 'keyword', value: 'a' }).ok, false);
ok('short keyword warns', !!buildRule({ type: 'keyword', value: 'sho' }).warning, true);
ok('bad regex rejected', buildRule({ type: 'regex', value: '(' }).ok, false);
ok('good regex accepted', buildRule({ type: 'regex', value: '^https://a\\.com' }).ok, true);

console.log('regex guards (a user pattern runs against page-controlled text)');
ok('nested quantifier: (a+)+', hasNestedQuantifier('(a+)+'), true);
ok('nested quantifier: (a*)*', hasNestedQuantifier('(a*)*'), true);
ok('nested quantifier: (\\w+\\s?)*', hasNestedQuantifier('(\\w+\\s?)*'), true);
ok('nested quantifier: (a+)+$ anchored', hasNestedQuantifier('(a+)+$'), true);
ok('plain repeated group (ab)+ passes', hasNestedQuantifier('(ab)+'), false);
ok('alternation (foo|bar)+ passes', hasNestedQuantifier('(foo|bar)+'), false);
ok('non-capturing (?:ab)+ passes', hasNestedQuantifier('(?:ab)+'), false);
ok('translate pattern passes', hasNestedQuantifier('^https://translate\\.google\\.[^/]+/'), false);
ok('no parentheses at all', hasNestedQuantifier('a+b'), false);
ok('runnable: normal pattern', isRunnableRegex('^https://a\\.com'), true);
ok('runnable: empty pattern refused', isRunnableRegex(''), false);
ok('runnable: over-long pattern refused', isRunnableRegex('a'.repeat(REGEX_MAX_PATTERN + 1)), false);
ok('runnable: exactly at the cap allowed', isRunnableRegex('a'.repeat(REGEX_MAX_PATTERN)), true);

ok('buildRule refuses a nested quantifier', buildRule({ type: 'regex', value: '(a+)+$' }).ok, false);
ok('buildRule says why', /repeats inside another repeated group/.test(buildRule({ type: 'regex', value: '(a+)+$' }).error), true);
ok('buildRule refuses an over-long pattern', buildRule({ type: 'regex', value: 'a'.repeat(REGEX_MAX_PATTERN + 1) }).ok, false);
ok('buildRule still accepts a normal pattern', buildRule({ type: 'regex', value: '^https://translate\\.google\\.[^/]+/' }).ok, true);

resetSkippedRegexes();
const started = Date.now();
ok('catastrophic pattern matches nothing', findMatch({ url: 'https://ok.example/', title: 'a'.repeat(60) + '!' }, [regex('(a+)+$')]), null);
const elapsed = Date.now() - started;
ok(`catastrophic pattern returns in under 50ms (took ${elapsed}ms)`, elapsed < 50, true);
ok('and the skipped pattern is reported', skippedRegexes(), ['(a+)+$']);

resetSkippedRegexes();
ok('regex still matches normal text after a skip', !!findMatch({ url: 'https://translate.google.com/?text=hi', title: '' }, [regex('^https://translate\\.google\\.[^/]+/')]), true);
ok('nothing wrongly reported as skipped', skippedRegexes(), []);

// A stored pattern that predates the guard is skipped, not run.
const legacy = 'legacy-rules-skip';
resetSkippedRegexes();
ok('legacy nested pattern is skipped, not run', findMatch({ url: 'https://ok.example/', title: 'a'.repeat(30) + '!' }, [regex('(a+)+$')]), null);
resetSkippedRegexes();

console.log('regex input truncation');
const longTail = 'x'.repeat(REGEX_MAX_TEXT) + 'needle';
ok('match beyond the cap is not seen', findMatch({ url: 'https://ok.example/', title: longTail }, [regex('needle')]), null);
ok('match inside the cap is seen', !!findMatch({ url: 'https://ok.example/', title: 'x'.repeat(20) + 'needle' }, [regex('needle')]), true);

console.log(`\nmatcher: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
