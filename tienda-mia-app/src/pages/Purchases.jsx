import PhaseNotice from '../components/PhaseNotice'

export default function Purchases() {
  return (
    <PhaseNotice
      title="Purchases"
      phase="1 (next)"
      unlocksWith="Wire this to purchases + purchase_lines: posting a line creates a batch, appends an inventory_ledger row, and updates current cost automatically."
    />
  )
}
