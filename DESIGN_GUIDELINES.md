# DESIGN_GUIDELINES.md

## SWP Summit 2027 Design System

This app is the registration and checkout system for SWP Summit 2027 by People Strategy Hub. It should feel premium, calm, trustworthy, conversion-focused, and aligned with the SWP Summit website.

Admin screens should feel clean, structured, and efficient. Public checkout screens should feel more premium and editorial, but still clear and direct.

## Visual Language

The SWP Summit 2027 aesthetic is premium B2B enterprise:

- Sophisticated
- Commercial
- Expensive
- Strategic
- Calm and trustworthy

Avoid generic SaaS dashboard styling, generic conference templates, flat unbranded UI, cartoon illustration, and heavy decoration in critical checkout flows.

## Colour Palette

Use these core colours:

```css
:root {
  --swp-blue: #004eb9;
  --swp-blue-light: #266cc7;
  --swp-blue-wash: #f0f6ff;
  --swp-text-dark: #000000;
  --swp-text-muted: #4a5568;
  --swp-border: #e2e8f0;
  --swp-border-blue: rgba(0, 78, 185, 0.15);
}
```

Guidance:

- Use `#004eb9` for brand anchors, active states, primary icons, highlights, and key CTAs.
- Use `#266cc7` in gradients, hover states, and supporting accents.
- Use `#f0f6ff` for quiet background sections, hover washes, and inactive chips.
- Use black for headings and primary body copy.
- Use `#4a5568` or `#444444` for secondary copy.
- Use faint borders only. Avoid harsh black or dark grey dividers.
- Remove HR Analytics Summit orange `#E74F3E` and `rgba(231,79,62,...)` unless explicitly required for a historical reference.

## Typography

Use Figtree with sensible system fallbacks.

Headings:

- Use weights `700` or `800`.
- Keep headings tight and editorial.
- Use `letter-spacing: -0.02em` where it improves polish.
- Use line-height around `1.15` to `1.2` for large headings.

Body copy:

- Use readable sizing.
- Use line-height `1.5` to `1.6`.
- Keep checkout copy direct and reassuring.

Eyebrows and labels:

- Use uppercase.
- Use strong weight.
- Use wider letter spacing.
- Use SWP blue.

## Buttons

Use the SWP premium button system. Prefer existing classes:

- `.swp-primary-btn`
- `.swp-secondary-btn`
- `.swp-btn-text`
- `.swp-btn-arrow`

Primary buttons:

- White text.
- `135deg` linear gradient from `#004eb9` to `#266cc7`.
- `1px solid rgba(255,255,255,0.15)`.
- Soft blue shadow.
- Hover lift: `translateY(-3px) scale(1.02)`.
- Hover shadow should deepen with blue tint.

Secondary buttons:

- Text `#004eb9`.
- Transparent background.
- `2px solid #004eb9`.
- Hover background `#f0f6ff`.
- Hover border `#266cc7`.
- Soft blue shadow and subtle lift.

Button content:

- Buttons should contain a text span.
- Where appropriate, add a lightweight right-arrow SVG or Lucide icon.
- Arrow icons should gently nudge right on hover.
- Use accessible focus states.

## Cards And Containers

Use:

- White backgrounds
- Soft blue wash backgrounds
- Faint structural borders
- Blue-tinted shadows

Radius:

- Large cards and containers: `16px` to `24px`
- Smaller interactive cards: `8px` to `12px`

Shadows:

- Keep shadows subtle and blue-tinted.
- Avoid harsh dark generic shadows.

Interaction:

- Interactive cards may lift gently on hover.
- Avoid distracting motion on form-heavy pages.
- Prioritise trust, clarity, and scanability.

## Premium Visual Flourishes

Use visual depth sparingly:

- Architectural dot grids behind major sections
- Soft radial blue lighting for depth
- Glassmorphism for floating panels or high-level containers only

Do not overuse animation or effects inside critical form flows. Decorative effects should never make forms harder to understand or complete.

## Iconography

Use lightweight line icons in a Lucide style.

Icon rules:

- Use `currentColor`.
- Use SWP blue for most brand icons.
- Avoid cartoon, filled, or multi-coloured illustrations.
- Icons should support comprehension, not decorate every element.

## Public Checkout UX

Checkout should feel:

- Calm
- Premium
- Trustworthy
- Clear
- Conversion-focused

Prioritise:

- Clear step hierarchy
- Reassuring payment and invoice copy
- Visible PO and procurement guidance
- Clear CTAs
- Good mobile readability

Do not hide important invoice or procurement information in long paragraphs below forms.

## Admin UX

Admin screens should feel:

- Clean
- Structured
- Efficient
- Dense enough for repeated operational use

Avoid over-decorating admin screens. Use hierarchy, spacing, table clarity, filters, badges, and status treatments to improve speed and confidence.

## Engineering Constraints For Design Work

Prefer UI-only changes for visual tasks.

Do not change:

- Database schema
- Stripe logic
- Invoice logic
- VAT logic
- Promo code logic
- Group discount logic
- Booking status logic
- Attendee logic
- Monetary calculations

Do not edit generated API clients or generated Zod files by hand. If an API contract changes, update OpenAPI first and regenerate.

Improve one screen or flow at a time.

Do not add dependencies unless there is a clear reason and approval.

## Validation Checklist

After frontend changes, run:

```bash
pnpm run typecheck
pnpm --filter @workspace/checkout run build
```

When relevant, also run:

```bash
pnpm run lint
pnpm run test
pnpm run build
```

Summaries should include:

- Changed files
- Visual changes
- Checks run
- Risks, assumptions, or follow-up notes
