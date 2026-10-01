import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { THEMES, normalizeTheme } from '../src/lib/theme.js';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const prepaint=html.match(/<script>([\s\S]*?)<\/script>/)[1];
test('exactly three named themes, dark default and legacy preference migration',()=>{
 assert.deepEqual(THEMES.map(t=>[t.id,t.name]),[['midnight','Midnight'],['latte','Latte'],['office','Office']]);
 for(const [stored,expected] of [[null,'midnight'],['dark','midnight'],['light','office'],['midnight','midnight'],['latte','latte'],['office','office'],['system','midnight'],['broken','midnight']]){
   assert.equal(normalizeTheme(stored),expected);
   const root={dataset:{},style:{},classList:{toggle(name,value){this[name]=value;}}};
   vm.runInNewContext(prepaint,{localStorage:{getItem:()=>stored},document:{documentElement:root}});
   assert.equal(root.dataset.theme,expected);assert.equal(root.classList.dark,expected==='midnight');assert.equal(root.style.colorScheme,expected==='midnight'?'dark':'light');
 }
});
test('blocked storage still applies historical dark palette before paint',()=>{
 const root={dataset:{},style:{},classList:{toggle(name,value){this[name]=value;}}};
 vm.runInNewContext(prepaint,{localStorage:{getItem(){throw Error('blocked');}},document:{documentElement:root}});
 assert.equal(root.dataset.theme,'midnight');assert.equal(root.classList.dark,true);
});
test('Midnight retains baseline colors; palettes have no typography or geometry overrides',()=>{
 const css=readFileSync(new URL('../src/index.css',import.meta.url),'utf8');
 const dark=css.match(/\.dark\s*\{([^}]+)\}/)[1];
 assert.match(dark,/--background: 0 0% 10%/);assert.match(dark,/--card: 0 0% 16%/);assert.match(dark,/--primary: 142\.1 76\.2% 36\.3%/);assert.match(dark,/--sidebar: 0 0% 13%/);
 const latte=css.match(/:root\[data-theme="latte"\]\s*\{([^}]+)\}/)[1];assert(!/font|radius|padding|margin|height|width/.test(latte));
});

test('broker functional roles reuse existing Midnight colors without changing global tokens',()=>{
 const css=readFileSync(new URL('../src/index.css',import.meta.url),'utf8');
 const scoped=css.match(/\.dark \.broker-colors\s*\{([^}]+)\}/)[1];
 assert.match(scoped,/--broker-control-outline: var\(--muted-foreground\)/);
 assert.match(scoped,/--broker-error-text: var\(--foreground\)/);
 assert(!/#[0-9a-f]|\d/.test(scoped));
 const dark=css.match(/\.dark\s*\{([^}]+)\}/)[1];
 assert.match(dark,/--input: 0 0% 28%/);assert.match(dark,/--destructive: 0 62\.8% 30\.6%/);
});
