// Unit tests for the matching engine: node tests/matcher.test.mjs
import {
  findMatch,
  findExempt,
  explainExempt,
  rankUncovered,
  explainMatch,
  excerptAround,
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
} from '../src/matcher.js';
import { buildRule, normalizeDomain, splitRuleValues } from '../src/store.js';

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

console.log('why an entry went: which text, which word, and where in it');

// A URL of the kind that made the log unreadable: two kilobytes of token with the
// matching letters somewhere inside.
const tokenUrl = 'https://nordaccount.com/oauth2/initiate?challenge=' + 'N'.repeat(180) + 'zDgaY_krxd6DvgF' + 'Q'.repeat(180);
const inToken = explainMatch({ url: tokenUrl, title: 'Sign in' }, [keyword('gay')]);
ok('a word buried in a token is still reported', !!inToken, true);
ok('and it says the address is where it landed', inToken.field, 'url');
ok('the letters at that spot really are the word', tokenUrl.slice(inToken.at, inToken.at + 3), 'gaY');

ok('a word only in the title says title',
  explainMatch({ url: 'https://x.example/a', title: 'two gay guys dancing' }, [keyword('gay')]).field, 'title');
ok('when both hold it, the address is named',
  explainMatch({ url: 'https://x.example/gay', title: 'gay' }, [keyword('gay')]).field, 'url');
ok('the word reported is the rule value, not the letters found',
  explainMatch({ url: 'https://x.example/GAY', title: '' }, [keyword('gay')]).word, 'gay');

// Whole word: the index has to account for the boundary group in front of the match.
const whole = explainMatch({ url: 'https://x.example/a', title: 'buy shoes now' }, [keyword('shoes', true)]);
ok('whole word: the index points at the word itself', whole.at, 4);
ok('whole word: no partial hit means no explanation', explainMatch({ url: 'https://shoeshine.example/', title: '' }, [keyword('shoes', true)]), null);

// Rules that cover a whole address have no one spot in it that made them match.
const site = explainMatch({ url: 'https://example.com/a', title: 'Example' }, [domain('example.com')]);
ok('a site rule has no spot to point at', site.at, null);
ok('and it carries the site', site.word, 'example.com');
ok('an address rule carries the prefix', explainMatch({ url: 'https://example.com/private/1', title: '' }, [url('https://example.com/private')]).word, 'https://example.com/private');
const pat = explainMatch({ url: 'https://x.example/', title: 'Hello World' }, [regex('World')]);
ok('a pattern reports the text it matched', pat.word, 'World');
ok('and which text that was in', pat.field, 'title');

ok('a chrome:// page explains nothing', explainMatch({ url: 'chrome://settings', title: 'gay' }, [keyword('gay')]), null);

// The neighbourhood, which is what a row shows instead of the address.
const cut = excerptAround(tokenUrl, inToken.at, 'gay');
ok('the excerpt contains the word', cut.toLowerCase().includes('gay'), true);
ok('it is a neighbourhood, not the address', cut.length < 90, true);
ok('it marks both cuts', cut.startsWith('…') && cut.endsWith('…'), true);
console.log(`    the row would read: ${cut}`);
ok('a short text is not decorated', excerptAround('cheap shoes', 6, 'shoes'), 'cheap shoes');
ok('an excerpt from the start has one cut only', excerptAround('shoes and more', 0, 'shoes').startsWith('…'), false);

// The property the log depends on: the explanation never disagrees with the decision.
const items = [
  { url: 'https://nordaccount.com/x?c=' + 'a'.repeat(50) + 'gay', title: 'Sign in' },
  { url: 'https://ok.example/p', title: 'two gay guys dancing' },
  { url: 'https://shoeshine.example/', title: '' },
  { url: 'chrome://settings', title: 'gay' },
  { url: 'https://example.com/private/1', title: '' },
  { url: 'https://translate.google.com/?text=hi', title: '' },
];
const rules = [keyword('gay'), keyword('shoes', true), domain('example.com'), url('https://example.com/private'), regex('^https://translate\\.google\\.[^/]+/')];
for (const rule of rules) {
  for (const item of items) {
    const decided = findMatch(item, [rule]);
    const explained = explainMatch(item, [rule]);
    ok(`agrees with itself for ${rule.type} on ${item.url.slice(0, 28)}`,
      String(decided && decided.id) === String(explained && explained.rule.id), true);
  }
}

// A pasted list: the field takes many values at once, and one of them may be junk.
console.log('\npasted lists');
ok('one value per line', splitRuleValues('domain', 'a.com\nb.com\nc.com'), ['a.com', 'b.com', 'c.com']);
ok('commas split as well', splitRuleValues('domain', 'a.com, b.com'), ['a.com', 'b.com']);
ok('blank lines and stray spaces go', splitRuleValues('domain', '  \n a.com \n\n'), ['a.com']);
ok('a keyword keeps its comma', splitRuleValues('keyword', 'two guys, dancing'), ['two guys, dancing']);
ok('an empty field makes nothing', splitRuleValues('domain', '   \n\t'), []);
const pasted = splitRuleValues('domain', 'https://www.a.com/some/page\nb.com\nc.com, d.com');
ok('four values out of three lines', pasted.length, 4);
ok('every pasted site builds a rule', pasted.map((v) => buildRule({ type: 'domain', value: v }).ok), [true, true, true, true]);
ok('a pasted line of junk is refused', buildRule({ type: 'domain', value: 'not a domain!' }).ok, false);

// The suggestion side: what a person visits a lot and no rule covers. The teeth are in
// the first check, because a site that would be wiped must never be suggested back.
console.log('\nwhat a person visits and no rule covers');
const history = [
  { url: 'https://covered.example/x', title: 'x', visitCount: 50, lastVisitTime: 5 },
  { url: 'https://busy.example/a', title: 'a', visitCount: 40, lastVisitTime: 1 },
  { url: 'https://www.busy.example/b', title: 'b', visitCount: 35, lastVisitTime: 9 },
  { url: 'https://quiet.example/c', title: 'c', visitCount: 3, lastVisitTime: 30 },
  { url: 'chrome://settings', title: 'browser page', visitCount: 99, lastVisitTime: 99 },
];
const ranked = rankUncovered(history, [domain('covered.example')], 10);
ok('a site that would be wiped is never suggested', ranked.map((r) => r.host).includes('covered.example'), false);
ok('www and the bare host are one site', ranked[0].host, 'busy.example');
ok('its visits add up', ranked[0].visits, 75);
ok('browser pages are not suggestions', ranked.map((r) => r.host).includes('settings'), false);
ok('ranked by visits, most first', ranked.map((r) => r.host), ['busy.example', 'quiet.example']);
ok('the list respects its cap', rankUncovered(history, [], 1).length, 1);
ok('a switched-off rule covers nothing', rankUncovered(history, [{ ...domain('busy.example'), enabled: false }], 5).map((r) => r.host).includes('busy.example'), true);
ok('entries without a count still count once', rankUncovered([{ url: 'https://one.example/a' }, { url: 'https://one.example/b' }], [], 5)[0].visits, 2);

// An exemption is a promise, so it holds whatever order the list is in.
{
  const wipe = { id: 'w1', type: 'domain', value: 'shop.example', includeSubdomains: false, enabled: true };
  const keepRule = { id: 'k1', type: 'domain', value: 'shop.example', includeSubdomains: false, enabled: true, exempt: true };
  const item = { url: 'https://shop.example/cart', title: 'Cart' };

  ok('an exemption keeps a page the wipe list also matches', findMatch(item, [wipe, keepRule]), null);
  ok('the same answer with the exemption written first', findMatch(item, [keepRule, wipe]), null);
  const why = explainExempt(item, [wipe, keepRule]);
  ok('and the log can name the rule that kept it', why && why.rule.id, 'k1');
  ok('a switched-off exemption keeps nothing', findMatch(item, [wipe, { ...keepRule, enabled: false }]).id, 'w1');
  ok('an exemption of another type still wins', findMatch(item, [wipe, { ...keyword('cart'), id: 'k2', exempt: true }]), null);
  ok('a rule that is not an exemption still wipes', findMatch(item, [wipe]).id, 'w1');
  ok('a plain rule is not read as an exemption', findExempt(item, [wipe]), null);

  const busy = [{ url: 'https://busy.example/a', visitCount: 9 }, { url: 'https://busy.example/b', visitCount: 9 }];
  ok('an exempted site is never suggested back', rankUncovered(busy, [{ ...domain('busy.example'), id: 'k3', exempt: true }], 5).length, 0);
  ok('while a site nobody covers still is', rankUncovered(busy, [], 5)[0].host, 'busy.example');
}

console.log(`\nmatcher: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
