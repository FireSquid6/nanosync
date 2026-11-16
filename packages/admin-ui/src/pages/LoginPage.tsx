import { Navigate, useLocation } from "react-router-dom";
import { Button } from "../paper/Button";
import { TextField } from "../paper/TextField";
import { formData } from "../forms";
import { useAdmin } from "../state/AdminContext";

export function LoginPage() {
  const { authenticated, login, run, busy } = useAdmin();
  const location = useLocation();
  if (authenticated) {
    const destination: unknown = location.state?.from;
    return <Navigate replace to={typeof destination === "string" && ["/clients", "/vaults", "/activity"].includes(destination) ? destination : "/clients"} />;
  }
  return (
    <form className="nv-panel nv-stack" onSubmit={(event) => {
      const fields = formData(event);
      event.currentTarget.reset();
      void run(() => login(String(fields.get("password"))));
    }}>
      <title>Log in · Nanosync administration</title>
      <h2>Log in</h2>
      <TextField label="Owner password" name="password" type="password" autoComplete="current-password" required />
      <Button type="submit" disabled={busy}>Log in</Button>
    </form>
  );
}
