# Email Newsletter — v4.14 Feature Release

**Send timing:** Week 3 of campaign
**Audience:** Existing users / opt-in list
**Goal:** Re-engage, drive return visits, spark word-of-mouth

---

## Subject lines (A/B test these)

**Option A:** What's new in ClashControl v4.14 — Walk mode, Sheets, IDS export
**Option B:** You can now walk through your IFC model. Here's everything new in v4.14.
**Option C:** Free clash detection just got a lot more capable

**Preview text:** Walk mode, annotated floor plans with DXF export, IDS support, AI improvements, and more.

---

## Email body

---

**Subject:** What's new in ClashControl v4.14

Hi [first name],

ClashControl v4.14 is out — and it's a big one.

Here's what's new:

---

**Walk mode**

Navigate through your IFC model at eye height. Useful for visualising clearance clashes in mechanical rooms, corridors, and tight coordination zones. Unit-aware speed, configurable eye height, smooth first-person controls.

---

**Sheets — annotated floor plans with DXF export**

Generate a floor plan cut at any height. Annotate elements directly on the cut. Export as DXF for site teams, contractors, or coordinators who live in 2D CAD tools.

Settings: cut height, view depth, paper size, plot scale.

---

**IDS import/export**

ClashControl now supports the buildingSMART **Information Delivery Specification (IDS)** format for Data Quality checks. Import IDS files to validate models against project requirements. Export your checks as IDS for sharing with consultants or archiving.

---

**Smarter soft clash markers**

Soft clash markers now sit at the actual closest point between the two elements — weighted toward the smaller element. No more markers floating in the middle of a long beam.

---

**Discipline-colored outlines**

When you select or inspect a clash, element outlines now match the model category:
- Structural → blue
- MEP → red
- Architectural → purple
- Civil → green

Makes multi-model clash reviews significantly faster to parse.

---

**AI improvements**

- Detection status now shows as a live animated bar in the chat panel while detection is running
- Multi-model scoping in NL commands ("check MEP vs structure only")
- Shaded ghost rendering for non-highlighted elements

---

**What else is in v4.14**

Clearance and Tolerance tooltips on hover, cleaner clash cards (penetration depth removed from hard clash cards), and a dozen smaller fixes.

Full changelog: [CHANGELOG.md on GitHub](#)

---

**Try it now**

→ [Open ClashControl](https://www.clashcontrol.io)

It's free. No account. No install. If it's saving your team money, consider [sponsoring the project](https://github.com/sponsors/clashcontrol-io) — every contribution helps keep development going.

---

Thanks for using ClashControl,

— The ClashControl team

---

*You're receiving this because you signed up for ClashControl updates. [Unsubscribe](#)*

---

## Design notes for email layout

- **Header:** ClashControl logo / wordmark on dark background (#0f172a)
- **Section dividers:** Thin horizontal rule, same dark background
- **Feature headers:** Cyan accent (#06b6d4) for section titles
- **CTA button:** "Open ClashControl" — white text on cyan (#06b6d4) background
- **Footer:** Dark, small text, unsubscribe link
- **Image placements:** One screenshot per major feature (Walk Mode, Sheets, discipline outlines)
- **Mobile:** Single column, 600px max width

---

## Tracking

- UTM parameters on all links: `?utm_source=email&utm_medium=newsletter&utm_campaign=v414-release`
- Track: open rate (target >40%), click rate on "Open ClashControl" CTA (target >8%)
