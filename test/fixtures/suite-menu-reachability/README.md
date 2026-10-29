Real released-CCZ `suite.xml` files for `test/lib/suite-menu-reachability.test.ts` (ace#3340).

Both are the coach Deliver app of `smallholder-seasonal/20261029-1243`, HQ app
`0a070eec66e2464c99800a72342a7bc7` on `connect-ace-prod`, downloaded with
`commcare_download_ccz` on 2026-10-29:

- `coach-deliver-v51-broken.suite.xml` — build `140ffd28f85f4113938935413d915adf` (v51). Five menus have a view-only
  `mN-case-list` command and child menus; on CommCare 2.64.0 eleven forms could not be opened.
- `coach-deliver-v72-fixed.suite.xml` — build `31d61f4515ce41e7a17e2dc8fc2b5440` (v72). Flat root menus; every form
  path was walked on a device.
