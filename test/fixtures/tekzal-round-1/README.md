# tekzal Round 1 — captured artifacts

The exact documents tekzal reviewed in their Round 1 UAT, exported from the run folder
`ACE/tekzal/runs/20261013-2314/` on 2026-11-25.

| File | Source |
|---|---|
| `work-order.txt` | `1-design/pdd-to-work-order-2.gdoc` (revision 30) |
| `manager-guide.txt` | `6-qa-and-training/training-llo-guide.md` (revision 20) |
| `flw-guide.txt` | `6-qa-and-training/training-flw-guide.md` (revision 103) |
| `quick-reference.txt` | `6-qa-and-training/training-quick-reference.md` (revision 23) |
| `faq.txt` | `6-qa-and-training/training-faq.md` (revision 22) |

These are **negative controls** for `skills/reconcile-outputs`. Nine of its ten checks fail on
this set, and each failure corresponds to a defect the partner logged independently in their
issue log (rows 8, 10, 16, 22, 23, 24, 25, 27, 29, 32).

Do not "fix" these files. Their value is that they are wrong in the specific ways a real partner
found, which is what makes them able to prove a check works. A check that passes this set is not
checking anything.
