import { useEffect, useState } from "react";
import { emptyAppleCalendar, type AppleCalendarApi } from "../shared/apple-calendar";

export function useAppleCalendar(api: AppleCalendarApi | undefined) {
  const [state, setState] = useState(emptyAppleCalendar);
  useEffect(() => {
    if (!api) return;
    let active = true, updated = false;
    const remove = api.subscribe(next => { updated = true; if (active) setState(next); });
    const online = () => { void api.refresh().catch(() => {}); };
    window.addEventListener("online", online);
    void api.state().then(next => { if (active && !updated) setState(next); }).catch(() => {});
    return () => { active = false; remove(); window.removeEventListener("online", online); };
  }, [api]);
  return state;
}
