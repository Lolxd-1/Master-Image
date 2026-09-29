/**
 * Hardcoded user accounts (SPEC.md §2 — no signup, no password reset, no email).
 *
 * These are STARTER passwords, meant to be changed immediately after handover.
 * To add or rotate an account:
 *   1. Run: npm run user:add <username> <password> [admin|picker]
 *   2. Paste the printed line into the `users` record below, replacing any
 *      existing entry for that username.
 *   3. Redeploy (`npm run deploy`).
 *
 * Starter accounts (change these!):
 *   admin  / admin123    -> role admin
 *   store1 / store1pass  -> role picker
 *   store2 / store2pass  -> role picker
 *   store3 / store3pass  -> role picker
 *   store4 / store4pass  -> role picker
 *   store5 … store29 / store5pass … store29pass  -> role picker (same pattern)
 */

export type Role = 'admin' | 'picker';

export interface UserRecord {
  /** Base64-encoded random salt (16 bytes), unique per user. */
  salt: string;
  /** Base64-encoded PBKDF2-SHA256 derived key (100000 iterations, 32 bytes). */
  hash: string;
  role: Role;
}

export const users: Record<string, UserRecord> = {
  admin: { salt: '2MqoeTy+MDHL3DWAdtm9Yw==', hash: 'hIVgesccK48iiDP1V4XEL1TFUuhqpjseDtiI2ZiF6+A=', role: 'admin' },
  store1: { salt: '2fEW1FRTYDfzwcDpE0WLWA==', hash: 'a1ii9C8tZwcovSwqDV/AAEaEZBASE7wsQsc5onF5x7g=', role: 'picker' },
  store2: { salt: 'oHPOA1UfbmplwR3N/JsPEw==', hash: 'yXByrX9ka2ErtPWn+xx4KPIpm3E4mbN0/Mp9CF3kCfo=', role: 'picker' },
  store3: { salt: 'i+IiH6tJVxrak44kzF+YVg==', hash: 'zaJOBPQC3iEZZyotpk3+/hD21eZmjZ/JvQ7tMCOSrvI=', role: 'picker' },
  store4: { salt: 'pcpaTv46RGU2kTMRcZRqbA==', hash: 'NbUShGfD7x/Ykex/OZstHu3LPUdleVT70N+2wf2JViM=', role: 'picker' },
  store5: { salt: 'EiPbICc6JDwToludexcMqQ==', hash: 'ZJsgrqcL5LxO24OVwsB4uObDo9VDZB9pv11WWYrHob0=', role: 'picker' },
  store6: { salt: 'wstlCJtY1H09XKy0tnJNrg==', hash: 'AhwKQECrD4w8zPmMBZE7g1Ur6pe2imj5PXVvJvTjOxs=', role: 'picker' },
  store7: { salt: 'Z3c8yO+CA6Yj7UMGlxKvfA==', hash: 'Dx5oR8UYvpcrHcVw+nhB56Uviac6L2Eak+/NVHmyX0w=', role: 'picker' },
  store8: { salt: 'JWcY4ujT1guI8YZL5WUTxA==', hash: '6ianji2Nsk8XpSHXLMVLEayIvCO6l1VAXLXgCwQwI9k=', role: 'picker' },
  store9: { salt: 'OrZznQJILRGXkSEnssPVlg==', hash: 'v915hFoISji4iTLE4XGvDmYeo1i7Qmw/YgXw3lzlZ34=', role: 'picker' },
  store10: { salt: 'RhZbIFN7J/RObIFeYuRbQg==', hash: '1CyCdjKSRHJlxkkNbonrfPq/tlNwRps0zRH4vWTSvcc=', role: 'picker' },
  store11: { salt: 'ZEDmnjCCF9VzmnWHIZWnIQ==', hash: '/hWZUp8+RkObZJv/tA3KrylAAhE8LVVMou5pX792znE=', role: 'picker' },
  store12: { salt: 'ADQzWKx2cqA+p2zmJAbdPg==', hash: '74MY4Q1+TPJ2RWKgsqhHJgvCBUs9g7LovSVTQNTUMMg=', role: 'picker' },
  store13: { salt: 'L0zEZ7fYTmGMpYnqqTB5vQ==', hash: 'uvjx0ivN56iLLYdEaelb+qNSBcrcHmRawTlijG6Waug=', role: 'picker' },
  store14: { salt: '+vesqcczrL9d9yRLd5J7Dw==', hash: 'PS8P6al6a/FVMahn5c1YoQo9zquZyQPBNvfp4vDvYiU=', role: 'picker' },
  store15: { salt: 'sqSAoJV/Urz9MRVHCk9HhA==', hash: 're/ifc+Xy3SdppuQisW3SpfcpvrX0QW/LEe/xBC//us=', role: 'picker' },
  store16: { salt: 'C7Wqz6UqvLrV/mExTng4ZA==', hash: 'RYc1uXYy/V9FUjHkgJlOYNN/DyVKz9ZBVpWo/F4tSx0=', role: 'picker' },
  store17: { salt: 'Gin0yQRYCoNMwP0vrKmHUg==', hash: '/F/z0LEX2ltURFKPQBXfimWumOY+3MgwlZyzPKIhckc=', role: 'picker' },
  store18: { salt: 'bvv9pQFf3R1BCcOsaeAgrA==', hash: '0HH7Ky62yg1416ZEJTcdTDEscJpd3PrlhEznNG1cbBE=', role: 'picker' },
  store19: { salt: '6wHkm71ltN+OXxEZw/TyQQ==', hash: 'rw2FNLvNRjzW1UNmn9yMyAAV39VRO0/xeSvBtfG7xIo=', role: 'picker' },
  store20: { salt: '/tl3kQoPo5spuLVNfA4Dkg==', hash: 'yYHxXiKAZhku1urA1NnepGogcmYoXW9INgaQo7Xi8yU=', role: 'picker' },
  store21: { salt: '35NsYZULIWYdRafp78Acug==', hash: 'mFj9oelWCj5FNSuYh0XOLYj/GMr1xlTuy8mzIuRD9hw=', role: 'picker' },
  store22: { salt: 'sv/PwOOmN9vvxEbsVc3RUg==', hash: 'hM0VjRTazuIOotEgDIzeYgmYOuiFMKsCaPGccLGlipw=', role: 'picker' },
  store23: { salt: 'yrNPMVn7I1/2dkXoZqncDQ==', hash: 'U6sRcJwfrBfMQyMEYQV12qquzGooaihGiCMDGtD0jcY=', role: 'picker' },
  store24: { salt: 'zfg95qluI2HTY4TmMGlOLA==', hash: 'C4+Z728IIslvpSPnXYtvmXxhQAZUKAEK9IShs4H3jcE=', role: 'picker' },
  store25: { salt: 'WWog34JANNHAgzNU1hgaOw==', hash: 'O4rfsMgoUXTgLwWQvqUUDSmwrnFB0x7LRO69LoP7M0Y=', role: 'picker' },
  store26: { salt: '06pvcbT6ugC46noqQEhLtg==', hash: '2yQiMeAz3dju/kVRg42pYLKT3AoeVRAzbXI7bfxBY78=', role: 'picker' },
  store27: { salt: 'lGxKY1GLV8AK9I50qFGqcA==', hash: '9P+rZ0Pi6qRxSucFukkBpEYYfMZYW9Aopz/7N+WTs7M=', role: 'picker' },
  store28: { salt: 'jfjGgcHnhuB1oAWdeq8X2w==', hash: '4CUMPvvBYvvcKBGEVuE1EmHLAc2P7zlrYsVRnfl7rwo=', role: 'picker' },
  store29: { salt: 'tqeAMx2LyO854pbLmiLxew==', hash: 'R9IFVtBj/gqnjUFtHxU/m+LCVrB1TlizbpagYoRWZe0=', role: 'picker' },
};
