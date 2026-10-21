import { formatTess, shortAddress } from "../lib/format";
import { useReceivedDelegations } from "../lib/chain";
import { useWallet } from "../lib/session";
import { Select } from "./forms";

/**
 * Who pays: the active account, or an owner whose delegation the active account holds. Shown
 * only when the account holds a delegation. `""` is the account itself.
 */
export function PayWith({ value, onChange, label = "Pay with" }: { value: string; onChange: (owner: string) => void; label?: string }) {
  const { active, accounts } = useWallet();
  const nameOf = (address: string) => accounts.find((a) => a.address === address)?.name ?? shortAddress(address);
  const received = useReceivedDelegations(active?.address);
  if (!active || !received.data?.length) return null;
  return (
    <Select
      label={label}
      value={value}
      onChange={onChange}
      options={[
        { value: "", label: `${active.name}'s own TESS` },
        ...received.data.map((d) => ({ value: d.owner, label: `Budget of ${nameOf(d.owner)} · ${formatTess(d.remaining.planck, 2)} TESS left` })),
      ]}
    />
  );
}
