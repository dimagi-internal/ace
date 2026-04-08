# Intervention Design Document: Turmeric Market Survey

> **Source artifact.** This is the raw IDD as provided for ACE pipeline stress-testing.
> See [`idd-stress-test-observations.md`](idd-stress-test-observations.md) for the analysis of this IDD's gaps, verification strategy, and what it reveals about ACE skill requirements.
> This IDD is the cleaner of the two example cases — it maps directly onto the standard Connect atomic delivery model (one vendor = one photo + GPS + form) and makes a good first end-to-end test of the full ACE pipeline.

## Overview

FLWs visit markets to photograph turmeric vendors, capturing a yellow MTN card in each photo as a visual reference. Each visit also records the GPS location of the vendor. The goal is to build a geo-tagged dataset of turmeric market presence, pricing, and availability across a target area.

This is a single-stage data collection effort with no follow-up visits required.

## Background & Motivation

Turmeric is widely consumed as a spice and is a common ingredient in food across South Asia and parts of Africa. However, research has found that turmeric sold in many markets is adulterated with lead chromate, a bright yellow industrial pigment used to enhance the color of the spice and make it appear more vibrant and appealing to buyers.

Lead chromate is highly toxic. Even small amounts of lead exposure can cause serious and irreversible harm, particularly in young children, including cognitive impairment, developmental delays, and damage to the nervous system and kidneys. Because turmeric is used in cooking, lead-adulterated turmeric is a direct route of dietary lead exposure for entire households.

A key visual indicator of adulteration is shininess. Pure turmeric powder has a naturally matte, slightly rough appearance. Turmeric that has been adulterated with lead chromate tends to appear shinier and more uniformly bright. This visual difference is detectable by eye, and photos taken under consistent conditions—with a standard color reference like the yellow MTN card—can help analysts compare samples across markets and flag potential adulteration for follow-up testing.

This survey aims to:

- Map where turmeric is being sold across target markets
- Capture standardized photos that can be used to visually assess shininess and color consistency
- Build a baseline dataset to identify markets or vendors where adulteration may be more prevalent
- Inform decisions about where to conduct more rigorous lab-based testing

**Operational limits:**

- Maximum 20 vendor visits per FLW per day
- Maximum 5 vendor visits per market per day

## How It Works

At each vendor, the FLW:

- Captures GPS coordinates automatically via Connect
- Takes a photo of the turmeric with the yellow MTN card visible in the frame
- Completes the short form below

The MTN card serves as a standard color and size reference to allow comparison of turmeric color and quantity across photos.

## Connect Form Questions

### Location & Identification

1. What is the name of this market? (free text)
2. GPS coordinates (auto-captured by Connect)
3. Photo of turmeric with yellow MTN card visible (photo capture)

### Vendor

4. What type of vendor is this? (select one: fixed stall / roaming / wholesale trader / other)
5. Is the vendor male or female? (select one: male / female)

### Product

6. In what form is the turmeric being sold? (select one: fresh root / dried root / ground powder / other)
7. What is the price per [unit]? (numeric)
8. What unit is the price based on? (select one: kg / small heap / medium heap / large heap / bag / other)
9. Approximately how much stock does the vendor have available right now? (select one: very little / moderate amount / large amount)

### Origin

10. Does the vendor know where the turmeric came from? (yes / no)
11. If yes, where did it come from? (free text)

### Quality (FLW observation)

12. What is the color of the turmeric? (select one: bright yellow-orange / pale yellow / brownish / other)
13. Does the turmeric appear shiny? (select one: yes, noticeably shiny / somewhat shiny / no, matte appearance)
14. Any notable observations about appearance or condition? (free text, optional)

### Close-out

15. Any other notes about this vendor or visit? (free text, optional)

## Vendor Education

At the end of each visit, FLWs should share a brief message with the vendor. The goal is not to alarm or accuse, but to raise awareness that turmeric adulteration is a known problem and that vendors can play a role in protecting their customers.

**Key points to communicate:**

- Some turmeric sold in markets has been found to contain lead, a harmful substance that can make people sick, especially children.
- Lead is sometimes added to turmeric to make it look brighter and more appealing. One sign of this is that the turmeric looks unusually shiny.
- Vendors who buy from trusted sources and avoid unusually bright or shiny turmeric are less likely to be selling adulterated product.
- If a vendor is unsure about their supply, they can ask their supplier where the turmeric comes from and how it was processed.

FLWs should not make accusations or suggest that a specific vendor's product is definitely contaminated. The conversation should be friendly and informational. A good framing is: *"We are doing a survey to better understand where turmeric comes from and to share information about turmeric safety with vendors across the market."*

After delivering the education, the FLW records:

16. Did you share the education message with this vendor? (yes / no)
17. How did the vendor respond? (select one: receptive and interested / neutral / skeptical or dismissive / did not have time to engage)
18. Any notable comments from the vendor about their supply or sourcing? (free text, optional)

## Outputs

- Geo-tagged photo dataset of turmeric vendors across target markets
- Summary table of pricing, form, and stock availability by market
- Map of vendor locations
- Notes on turmeric origin and quality for follow-on analysis
