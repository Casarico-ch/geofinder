import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { MapPin, Search } from "lucide-react";

const NAV = [
  { href: "/", label: "Requests" },
  { href: "/usage", label: "Usage" },
];

// Shared header for the admin pages: the logo, Requests / Usage, and New search.
export default function AdminHeader({ subtitle }: { subtitle: string }) {
  const [location] = useLocation();
  return (
    <header className="border-b border-border sticky top-0 bg-background/90 backdrop-blur z-10">
      <div className="container py-3.5 flex items-center gap-2.5">
        <Link href="/" className="flex items-center gap-2.5 group min-w-0">
          <MapPin className="h-5 w-5 text-primary shrink-0" />
          <div className="min-w-0">
            <h1 className="hidden sm:block text-base font-semibold text-foreground group-hover:text-primary transition-colors">GeoFinder</h1>
            <p className="text-xs text-muted-foreground truncate hidden sm:block">{subtitle}</p>
          </div>
        </Link>
        <div className="flex-1" />
        {NAV.map((n) => (
          <Link key={n.href} href={n.href}>
            <Button variant="ghost" size="sm" className={`px-2 sm:px-3 ${location === n.href ? "text-primary" : ""}`}>
              {n.label}
            </Button>
          </Link>
        ))}
        <Link href="/new">
          <Button size="sm">
            <Search className="mr-1.5 h-3.5 w-3.5" />
            New search
          </Button>
        </Link>
      </div>
    </header>
  );
}
