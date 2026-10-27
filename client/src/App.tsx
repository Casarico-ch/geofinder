import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { lazy, Suspense } from "react";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import MagicFeedback from "./components/MagicFeedback";
import { ThemeProvider } from "./contexts/ThemeContext";

// Each page is its own chunk: opening one page does not download the others.
const AddressFinder = lazy(() => import("./pages/AddressFinder"));
const Requests = lazy(() => import("./pages/Requests"));
const Usage = lazy(() => import("./pages/Usage"));
const Practice = lazy(() => import("./pages/Practice"));
const PracticeRound = lazy(() => import("./pages/PracticeRound"));

function Router() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-background" />}>
      <Switch>
        <Route path={"/"} component={Requests} />
        <Route path={"/investigations"} component={AddressFinder} />
        <Route path={"/new"} component={AddressFinder} />
        {/* Keyed by id: another investigation starts from a fresh page. */}
        <Route path={"/i/:id"}>{(params) => <AddressFinder key={params.id} />}</Route>
        <Route path={"/requests"} component={Requests} />
        <Route path={"/usage"} component={Usage} />
        <Route path={"/practice"} component={Practice} />
        <Route path={"/practice/:id"} component={PracticeRound} />
        {/* Final fallback route */}
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <Router />
          <MagicFeedback />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
