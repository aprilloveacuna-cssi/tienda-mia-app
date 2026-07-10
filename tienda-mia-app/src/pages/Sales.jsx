import PhaseNotice from '../components/PhaseNotice'

export default function Sales() {
  return (
    <PhaseNotice
      title="Sales"
      phase="2"
      unlocksWith="Manual sales entry and POS import land here, drawing FIFO cost from batch_cache and posting negative ledger rows per line."
    />
  )
}
