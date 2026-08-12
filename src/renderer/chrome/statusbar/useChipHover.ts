import { useEffect, useRef, useState } from 'react'

/**
 * Shared hover state for the status-bar chips: a short grace window so moving the pointer from
 * the chip into its popover doesn't close it. Returns the trigger props and the open flag.
 */
export function useChipHover(): {
  open: boolean
  triggerProps: { onMouseEnter: () => void; onMouseLeave: () => void }
  popoverProps: { onMouseEnter: () => void; onMouseLeave: () => void }
} {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const enter = (): void => {
    if (timer.current) clearTimeout(timer.current)
    setOpen(true)
  }
  const leave = (): void => {
    timer.current = setTimeout(() => setOpen(false), 180)
  }
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  return { open, triggerProps: { onMouseEnter: enter, onMouseLeave: leave }, popoverProps: { onMouseEnter: enter, onMouseLeave: leave } }
}
