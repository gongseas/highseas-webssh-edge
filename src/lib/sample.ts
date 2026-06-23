import type { ServerProfileInput } from "../../shared/types";

export const emptyProfile: ServerProfileInput = {
  name: "新服务器",
  groupName: "默认分组",
  host: "",
  port: 22,
  username: "root",
  credentialKind: "password",
  password: "",
  privateKey: "",
  passphrase: "",
  hostFingerprint: ""
};
