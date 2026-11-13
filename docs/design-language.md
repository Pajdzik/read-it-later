# Potem design language

Recorded from the design review and follow-up discussion through November 12, 2026. This guide covers visual design, interaction, and interface wording for future agents.

## How to use this guide

Preserve the product direction below when changing the interface. Follow the current user's instructions when they revise a decision, and update this guide when a new direction is accepted.

The **reviewed baseline** describes the eleven design fixes reviewed together at commit `2d828b59d3f673d88bbf26891c452383e5393bc6`. It is a design reference, not a claim that every checkout or deployed version contains those changes. Check the working branch before implementation. The older [service design](design.md) is historical architecture context, not the current visual specification.

The **follow-up proposals** at the end were discussed after that review. Treat them as unapproved unless they are listed under accepted additions.

## Product character

Potem is a quiet, personal place to save and read articles. Simplicity is the main design constraint: emphasize the article, make the next action clear, and reveal secondary tools when needed.

- Use the lowercase **potem.** wordmark and the paired-bookmark pause symbol.
- Prefer space, typography, and subtle separators over repeated cards, badges, and prominent borders.
- Give primary actions more emphasis than secondary controls. Avoid making every action look equally important.
- Keep useful context and actionable failures visible. Simplification must preserve information needed to recover or make a decision.
- Show each editable value once. Avoid repeating the article's title, description, and tags above the same fields in its editor.

## Reviewed baseline: color and type

Dark mode uses a bottle-green background, warm text, and orange highlights. Light mode reverses the visual balance: warm paper, dark green accents, and selective burnt-orange emphasis. This is a reversal of roles, not a literal inversion of colors.

Reference tokens from the reviewed palette:

| Role / token | Light | Dark |
| --- | --- | --- |
| Page background `--paper` | `#F7F1E6` | `#102D24` |
| Raised surface `--white` | `#FFFAF2` | `#183A2F` |
| Main text `--ink` | `#2E2923` | `#F3EBDD` |
| Article title `--title` | `#145A42` | `#F3EBDD` |
| Secondary text `--muted` | `#6E6257` | `#BAC8BE` |
| Action accent `--accent` | `#145A42` | `#E9A17D` |
| Orange emphasis `--emphasis` | `#A64F2D` | `#E9A17D` |
| Subtle highlight `--highlight` | `#E4EDE5` | `#234638` |
| Separator `--line` | `#DDD2C3` | `#355449` |
| Focus `--focus` | `#3F795F` | `#8CBEA2` |
| Primary button text `--primary-foreground` | `#FFFAF2` | `#102D24` |

The dark background was chosen to remain visibly green; lighter green surfaces distinguish dialogs and controls. A darker alternative was later discussed (see below).

Use semantic CSS tokens rather than local color literals. Despite its legacy name, `--white` means a raised surface in both themes. Destructive actions and errors use the themed `--danger-surface`, `--danger-text`, and `--danger-outline` tokens. Native controls, placeholders, disabled states, focus indicators, and the capture page must belong to the same palette.

Apply the saved theme before the first paint. Support Light, Dark, and System; preserve an explicit choice when system appearance changes. Keep browser theme color consistent with the selected theme.

Use serif typography for article titles and reading content, with a sans-serif interface for controls, metadata, and forms. Preserve a clear hierarchy: title first, description second, source/author and tags third. Long titles and unbroken strings must wrap without running under controls. Keep reading lines comfortable and avoid shrinking text to fit actions.

## Reviewed baseline: library

- Keep Mark as read/unread directly available. Put Edit and Open original under More actions.
- Place the two action controls beside the title, aligned toward the top of the row. The reviewed implementation uses this arrangement at desktop and mobile widths; its mobile tradeoff is documented below.
- Give both controls 44 × 44 CSS-pixel targets with at least 8px separation. Icons can be smaller than their targets. Accent the read action and keep More quieter.
- Show source and optional author in the row. Keep the saved date in article details instead of repeating it in every row.
- Show two tags, then a `+N` disclosure for additional tags. Expanded tags remain filterable; `Less` collapses them. Provide descriptive accessible names for both states.
- Omit routine ready-copy badges. Keep pending and failed capture/recovery indicators visible, even when an older copy is available. Reserve the prominent checkmark association for the read action.
- Keep Continue reading compact. Hide it when the resumed article duplicates the first displayed article. Preserve Picked for you, Try another, and retry behavior for suggestions.

## Reviewed baseline: reader, editor, and Settings

**Reader:** Mark as read/unread is the primary completion action at the end of the article. Article ratings and favorites are available only for persisted saved copies; ephemeral previews do not expose feedback controls. It fills the reading column on narrow screens and uses its content width on desktop. Delete article lives under a quiet More actions popover. Keep the menu beside its trigger and within the viewport. Preserve confirmation, error reporting, request guards, dismissal, and focus restoration. Opening or scrolling an article never marks it read automatically.

**Editor:** Use an Edit article heading and one set of Title, Tags, and Description fields. Keep Clear actions small and inline, with field-specific accessible names. Keep generated-description provenance available, including to assistive technology. Put Markdown editing, capture/recovery, and integrations in labeled disclosures; retain discoverable reading and download actions. Reveal the relevant section when a missing-copy task or actionable error needs attention. Preserve drafts, focus, selection, and disclosure state through background updates. Failed recapture feedback must remain visible.

**Settings:** Keep Appearance and Account easy to find. Offer Back up library and Restore library disclosures containing the existing format choices. Collapse Private podcast and Integrations; group capture tokens and help under Saving from devices. Preserve keyboard access and hide irrelevant setup controls when signed out.

## Interface language

Use concise, calm, concrete language. Prefer sentence case and familiar verbs. Name the action and its object when context alone would be ambiguous. Avoid promotional language, generic success fanfare, and technical details that do not help the user act.

| Meaning | Preferred wording | Guidance |
| --- | --- | --- |
| Change unread to read | Mark as read | Use consistently in visible labels, accessible names, and tooltips. |
| Change read to unread | Mark as unread | Describe the action that will happen, not just the current state. |
| Secondary article actions | More actions | Icon-only controls still need this accessible name. |
| Save edited metadata | Save changes | Do not apply this label indiscriminately to link or Markdown saving. |
| Edit metadata | Edit / Edit article | Short menu action; explicit form heading. |
| Remove an article | Delete article | Confirm the specific article and irreversible consequence. |
| Resume an unfinished article | Continue reading | Distinct from a suggestion. |
| Suggested article | Picked for you | Keep Try another available when alternatives exist. |
| Clear a field | Clear | Accessible name identifies Clear tags or Clear description. |
| Export / import library | Back up library / Restore library | Keep format-specific choices inside. |

Keep saving a link, saving a Markdown copy, sending to an integration, and changing read state conceptually distinct. Their labels and feedback must describe the actual operation.

Report success only after success is confirmed. Errors should say what failed and provide a useful next step when available; preserve the user's draft. For example: “Couldn’t update this article. … Try again.” Do not hide a failure merely because a loading state ended.

## Accepted additions after review

At the top of the mobile reading list, pulling down refreshes the current filter and search. Show “Pull to refresh” while the gesture is below the threshold, “Release to refresh” when it is ready, and “Refreshing your list…” while the request runs. Keep the current articles visible until the refreshed list arrives.

## Follow-up proposals: not part of the reviewed implementation

### Vertical actions on mobile

Long titles exposed a weakness in keeping two buttons beside the title: the controls consume roughly 96px before the gap between text and controls. Moving actions below the content was discussed, followed by a preferred experiment: **stack Mark as read above More on the right on mobile**, retaining horizontal controls on desktop.

A vertical stack uses about 44px of width and 96px of height. It leaves more room for titles but can create empty space beside short entries. If requested, compare long and short entries and align the stack to the top of the article. This discussion did not authorize or implement a new layout.

### Darker background

`#0B1F18` was suggested as a darker base that would retain the bottle-green identity and make the reading environment quieter. It is a candidate, not a replacement token approved by the user. If adopted, review the surfaces, text, borders, focus, and orange accents together.

### Title-only hover emphasis

The follow-up recommendation was to highlight only the title when hovering over either the title or description. Keep the description muted even though it also opens the article. This preserves the hierarchy and avoids emphasizing the whole entry.

The user requested a reusable prompt for this behavior; implementation was not performed in this conversation. The prompt was:

> Highlight only the article title when hovering over either the title or description. Keep the description muted, preserve keyboard focus indicators on the focused link, and keep Mark as read and More hover states independent.

Hover is an enhancement. Keyboard focus must identify the actual focused control, and touch users must not depend on hover to discover actions.

## Checks for future interface changes

Inspect light and dark themes at representative widths: 320, 390, 620, 768, and 1200px. Include long/unbroken titles, short entries, missing descriptions, many tags, pending/failed capture, and read/unread states. Check element overlap and clipping as well as page-level overflow.

Verify keyboard focus, accessible names, touch targets, menu placement/dismissal, and focus after mutations or hidden shortcuts. Preserve drafts and actionable errors. Use the relevant existing browser/mobile checks for behavioral changes; documentation-only edits do not need application test runs.

Primary implementation references: `web/app.v1.css`, `web/app.ts`, `web/index.html`, and the theme/capture assets in `web/`. Search the current checkout for the relevant behavior before editing; do not assume this reference commit is the active implementation.
