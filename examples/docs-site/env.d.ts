/// <reference types="astro/client" />
/// <reference types="oxiquill/env" />

import type { JSX as AstroJSX } from 'astro/jsx-runtime';

// Bridge Astro's JSX namespace for TypeScript 6 diagnostics on standalone Astro pages.
declare global {
  namespace JSX {
    type Element = AstroJSX.Element;
    interface ElementChildrenAttribute {
      children: unknown;
    }
    type IntrinsicAttributes = AstroJSX.IntrinsicAttributes;
    interface IntrinsicElements {
      a: AstroJSX.IntrinsicElements['a'];
      body: AstroJSX.IntrinsicElements['body'];
      h1: AstroJSX.IntrinsicElements['h1'];
      head: AstroJSX.IntrinsicElements['head'];
      html: AstroJSX.IntrinsicElements['html'];
      li: AstroJSX.IntrinsicElements['li'];
      main: AstroJSX.IntrinsicElements['main'];
      meta: AstroJSX.IntrinsicElements['meta'];
      p: AstroJSX.IntrinsicElements['p'];
      style: AstroJSX.IntrinsicElements['style'];
      title: AstroJSX.IntrinsicElements['title'];
      ul: AstroJSX.IntrinsicElements['ul'];
    }
  }
}

export {};
