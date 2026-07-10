import PhaseNotice from '../components/PhaseNotice'

export default function Inventory() {
  return (
    <PhaseNotice
      title="Inventory"
      phase="1 (next)"
      unlocksWith="This view reads from inventory_cache and batch_cache — it has nothing to show until Purchases starts writing to the ledger."
    />
  )
}
