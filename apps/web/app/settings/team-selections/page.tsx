import { redirect } from "next/navigation";

/** Team selections matrix temporarily disabled; sends old bookmarks Home > Settings. */
export default function TeamSelectionsPage() {
  redirect("/settings");
}
