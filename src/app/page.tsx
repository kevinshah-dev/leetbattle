import { HomeExperience } from "@/components/HomeExperience";
import { SiteHeader } from "@/components/SiteHeader";

export default function HomePage() {
  return (
    <div className="site-shell">
      <SiteHeader />
      <HomeExperience />
    </div>
  );
}
