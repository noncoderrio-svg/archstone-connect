import { defineRailway, project, service, volume } from "railway/iac";

// Replaces railway.json (Railway stops reading Config as Code on 2026-12-01).
// Preview changes with `railway config plan`; apply with `railway config apply`.
// Variables stay unmanaged: set them in the Railway dashboard or with `railway variable set`, never in this file.
export default defineRailway(() => {
  // Holds the database, uploads, encryption key and backups. Never remove it from this file:
  // leaving a resource out of the file deletes it on the next apply.
  const archstoneConnectVolume = volume("archstone-connect-volume", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: "sfo",
    sizeMB: 500,
  });

  const archstoneConnect = service("archstone-connect", {
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    deploy: {
      healthcheckPath: "/healthz",
      healthcheckTimeout: 60,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
    },
    replicas: { "sfo": 1 },
    volumeMounts: { "/data": archstoneConnectVolume },
  });

  return project("archstone-connect", {
    variables: { managed: false },
    resources: [archstoneConnect, archstoneConnectVolume],
  });
});
