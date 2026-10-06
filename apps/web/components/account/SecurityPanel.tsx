"use client";

import { useState } from "react";
import { AdminModeSwitch } from "@/components/shell/AdminModeSwitch";
import { MfaSecurity } from "@/components/account/MfaSecurity";

/** Recovery codes stay in memory on this page until explicitly acknowledged. */
export function SecurityPanel() {
  const [recoveryPending, setRecoveryPending] = useState(false);
  return <>
    <div id="admin-mode" className="mt-6 scroll-mt-5"><AdminModeSwitch prominent recoveryPending={recoveryPending} /></div>
    <MfaSecurity onRecoveryCodesChange={setRecoveryPending} />
  </>;
}
