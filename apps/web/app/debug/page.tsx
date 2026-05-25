import { redirect } from "next/navigation";

/** Debug tools temporarily disabled; old links go to Settings. */
export default function DebugPage() {
  redirect("/settings");
}
