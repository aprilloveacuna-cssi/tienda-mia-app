import PhaseNotice from '../components/PhaseNotice'

export default function Kitchen() {
  return (
    <PhaseNotice
      title="Kitchen"
      phase="2"
      unlocksWith="Recipes and production runs live here — consuming ingredient batches and creating a new finished-good batch per run."
    />
  )
}
