// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from "node:url";

export default {
  resolve: {
    alias: {
      "@davidapps/telemetry-core": fileURLToPath(
        new URL("../core/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
  },
};
