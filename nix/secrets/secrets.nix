let
  # YubiKey: Primary daily driver.
  yubikey_primary = "age1yubikey1q0zhu9e7zrj48zmnpx4fg07c0drt9f57e26uymgxa4h3fczwutzjjp5a6y5"; # gitleaks:allow

  # YubiKey: Backup.
  yubikey_backup = "age1yubikey1qtdv7spad78v4yhrtrts6tvv5wc80vw6mah6g64m9cr9l3ryxsf2jdx8gs9"; # gitleaks:allow

  # Host age identities from /etc/age/key.txt.
  mom_1 = "age16293kjnhamtq3e4nu0q8ydcguy0eajesmkvakrxhudaqtdgq6dqqc38vjv";
  mom_stage_1 = "age1mtf29wt0we3adcja7k0ylc9hmf2fns3c44qz9g663l0ydepxqdrq94jzzf";

  allKeys = [
    yubikey_primary
    yubikey_backup
    mom_1
    mom_stage_1
  ];
in
{
  "nix/secrets/secrets.age".publicKeys = allKeys;
}
