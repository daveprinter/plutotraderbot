# Pluto Trader

Creates an app called Pluto AI Trader that, uh, the user enters derive PAT format token, then clicks Connect. Then it connects to the derive account and fetches the balance and displays it. Also

The user will choose from drop-down the available markets. That is Volatility ten 1S, 15 1S, twenty five 1S, thirty 1S, fifty 1S, seventy-five 1S, ninety 1S, one hundred 1S, Volatility ten Index, twenty-five Index, fifty Index, seventy-five Index, one hundred Index. Then the default market is Volatility ten 1S. For the default selected market, the tool will show the current live market price from Deriv via the connected account. Then, uh, there will be fields to enter stop loss, take profit, stake, martingale, and martingale. For example, if the martingale after the new stake is applied becomes a stake with more than two decimal places, the tool should automatically round off the stake to two decimal places since Deriv does not accept stake with more than two decimal places

Then this tool trades a differ contract. That means the user can differ any digit. For example, if the next digit should appear, uh, if you are differing five and the next digit that appears is not five, that is a win according to the read. Now, um, the user chooses mode of differ contract from, uh, selecting a card, a, a button card. The first one is multi-contract and the other one is single. For single, when the user clicks that, he enters a digit in a field which to predict to differ. When you select multi, uh, you can select any digits from zero to nine, and if I'm predicting, uh, multi, another option appears from dropdown to select the mode to transition between the multiple contracts. One is after one loses. The other one is, uh, randomly. So it keeps switching randomly around the selected digits, and the other one is sequential. It differs the contracts based on the order they were selected. Now, there is a mode called recovery mode. When the user enables this and turns on using a button, uh, extra fields in a panel appear. Uh, the user chooses the type of recovery mode. That is to recover with over prediction or under prediction or even prediction or odd prediction. When the user chooses to recover with under prediction or over prediction, a field appears to choose the ... To, to enter the prediction. But also in over and under recovery mode, when those are selected, the user chooses, uh, in another dropdown, uh, either multi or single contract. When the user chooses multi, to recover with multi and for example, he has chosen under, then he can select any digits from zero to nine in cards but in single only a field appears to enter the digit. When the user selects the multiple digits to recover with, for example, recovering with under, for example, seven and eight. The user chooses the mode to transition between the recovery. One, if the first recovery mode failed and brought a loss, then it will choose to the next recovery mode of under the next recovery digits. Then also, uh, the user can, uh, ch- The recovery contracts, the user can choose all of them at once. Then you can choose the mode to transition either after the first mode that is, for example, either over loses, then it will transition to under or even or odd, and the modes of transition are sequentially two after one loses. So for example, if I was recovering with over because it is the one that I had selected the first one and, uh, over loses as a recovery contract, now it will go to recovering with, for example, even if I have select- highlighted it. Then after the recovery, in case any recovery contract wins, it is only when the tool goes back to trading differs. The user also can choose to recover with only one recovery contract if he has not highlighted the, the rest. Also, add a log panel and a stats panel and clear button for log panel and a clear button for stats panel. The stats panel should track the profit and loss and number of contracts taken. Then the log panel will show the entries and the type of contracts that have been traded in the read form. I will share the image on how the log panel should appear as trades keep occurring. 

For the, for the app, use a blue and white theme and, uh, a dark theme that can be changed using a theme icon. When the user clicks the theme icon, it can switch to the, the, the dark theme. But for buttons and the rest, use a blue button design. I've shared the image of how the log panel will look like, and those contracts will keep coming in based on what user is trading                                                                                                                   for pat connection use this code :// src/lib/deriv.ts

export const DERIV_LEGACY_APP_ID = "1089";

// PAT tokens use Deriv's new PAT-format App ID.

export const DERIV_NEW_APP_ID = "33uaaVh8xkm8lpUWTHDkm";

const DERIV_LEGACY_WS =

  `wss://ws.derivws.com/websockets/v3?app_id=${DERIV_LEGACY_APP_ID}`;

const DERIV_REST_BASE =

  "https://api.derivws.com/trading/v1/options";

async function derivRest<T>(

  path: string,

  token: string,

  init?: RequestInit

): Promise<T> {

  let response: Response;

  try {

    response = await fetch(`${DERIV_REST_BASE}${path}`, {

      ...init,

      headers: {

        "Authorization": `Bearer ${token}`,

        "Deriv-App-ID": DERIV_NEW_APP_ID,

        "Content-Type": "application/json",

        ...(init?.headers || {}),

      },

    });

  } catch (error: any) {

    throw new Error(

      error?.message || "Could not reach Deriv PAT API"

    );

  }

  let body: any = null;

  try { body = await response.json(); } catch {}

  if (!response.ok) {

    throw new Error(

      extractDerivRestError(

        body,

        `Deriv PAT API failed (${response.status})`

      )

    );

  }

  return body as T;

}

export async function authorizeDeriv(

  rawToken: string

): Promise<DerivAuthResult> {

  const token = rawToken.trim();

  if (!token) throw new Error("Empty token");

  const mode = detectTokenMode(token);

  // ==================== LEGACY ====================

  if (mode === "legacy") {

    const ws = new DerivWS();

    ws.mode = "legacy";

    await ws.connect();

    const auth = await ws.send<any>({

      authorize: token

    });

    if (!auth?.authorize) {

      throw new Error("Invalid token (legacy)");

    }

    return {

      ws,

      loginid: auth.authorize.loginid,

      currency: auth.authorize.currency || "USD",

      balance: Number(auth.authorize.balance ?? 0),

      mode,

    };

  }

  // ==================== PAT ====================

  // Step 1: Get accounts list via REST

  const accountsResponse =

    await derivRest<{ data?: any[] | any }>(

      "/accounts",

      token,

      { method: "GET" }

    );

  const accounts = Array.isArray(accountsResponse.data)

    ? accountsResponse.data

    : accountsResponse.data

      ? [accountsResponse.data]

      : [];

  const account =

    accounts.find((a) => a?.status === "active") ||

    accounts[0];

  const accountId = String(

    account?.account_id ||

    account?.id ||

    account?.loginid ||

    ""

  );

  if (!accountId) {

    throw new Error(

      "No Deriv options account found for this PAT token"

    );

  }

  // Step 2: Request OTP to get an authenticated WebSocket URL

  const otpResponse =

    await derivRest<{

      data?: {

        url?: string;

        websocket_url?: string

      }

    }>(

      `/accounts/${encodeURIComponent(accountId)}/otp`,

      token,

      { method: "POST" }

    );

  const websocketUrl = String(

    otpResponse.data?.url ||

    otpResponse.data?.websocket_url ||

    ""

  );

  if (!websocketUrl) {

    throw new Error(

      "Deriv PAT API did not return a WebSocket URL"

    );

  }

  // Step 3: Connect directly using authenticated URL

  const ws = new DerivWS();

  ws.mode = "pat";

  await ws.connect(websocketUrl);

  // Values come from the REST account object.

  const balance = Number(account?.balance ?? 0);

  const currency = String(account?.currency ?? "USD");

  const loginid = accountId;

  return {

    ws,

    loginid,

    currency,

    balance,

    mode

  };

}                                                                                                                                                                               to avoid buy input validation errors make sure this code is added:// src/lib/botEngine.ts

const contractParams = {

  amount: stake,

  basis: "stake",

  contract_type: type,

  currency: "USD",

  duration: 1,

  duration_unit: "t",

  barrier: String(prediction),

};

const buyRes = this.ws.mode === "pat"

  ? await this.buyViaProposal(contractParams, stake)

  : await this.ws.send({

      buy: 1,

      price: stake,

      parameters: {

        ...contractParams,

        symbol: this.cfg.symbol

      },

    });

private async buyViaProposal(

  contractParams: Record<string, any>,

  stake: number

): Promise<any> {

  const proposalRes: any = await this.ws.send({

    proposal: 1,

    ...contractParams,

    underlying_symbol: this.cfg.symbol,

  });

  const proposalId = proposalRes?.proposal?.id;

  if (!proposalId) {

    throw new Error("Deriv did not return a proposal ID");

  }

  return this.ws.send({

    buy: proposalId,

    price: stake

  });

}                                                                                                                                                                            for everytick and immediate martingale use:// 1. Place trade

const placeTradeInternal = useCallback(async () => {

  if (tradeStateRef.current !== 'idle') return;

  const stake = currentStakeRef.current;

  const market = selectedMarketRef.current;

  const cur = currencyRef.current;

  tradeStateRef.current = 'buying';

  setTradeState('buying');

  try {

    const barrier =

      parseInt(configRef.current.barrier) || 7;

    const result =

      await derivApi.buyDigitUnder(

        market,

        stake,

        barrier,

        cur

      );

    pendingTradeRef.current = {

      buyPrice: result.buy_price,

      payout: result.payout,

    };

    tradeStateRef.current = 'awaiting';

    setTradeState('awaiting');

  } catch (error) {

    const msg =

      error instanceof Error

        ? error.message

        : 'Trade failed';

    toast.error(msg);

    tradeStateRef.current = 'idle';

    setTradeState('idle');

  }

}, []);

// 2. Tick handler

const tickHandlerRef =

  useRef<(tick: any) => void>(() => {});

tickHandlerRef.current = (tick: any) => {

  const pipSize = tick.pip_size || 2;

  const priceStr =

    Number(tick.quote).toFixed(pipSize);

  setCurrentPrice(priceStr);

  const digit =

    parseInt(priceStr[priceStr.length - 1]);

  setLastDigit(digit);

  const newHistory =

    [...digitHistoryRef.current, digit].slice(-200);

  digitHistoryRef.current = newHistory;

  setDigitHistory(newHistory);

  onTickCallbackRef.current?.(digit);

  onTickCallback2Ref.current?.(digit);

  // Settle pending trade on THIS tick

  if (

    tradeStateRef.current === 'awaiting' &&

    pendingTradeRef.current

  ) {

    const barrier =

      parseInt(configRef.current.barrier) || 7;

    const isWin = digit < barrier;

    const {

      buyPrice,

      payout

    } = pendingTradeRef.current;

    const profit =

      isWin ? payout - buyPrice : -buyPrice;

    processResult(

      isWin,

      profit,

      digit,

      buyPrice

    );

    pendingTradeRef.current = null;

    tradeStateRef.current = 'idle';

    setTradeState('idle');

  }

  // Auto-trade on the SAME tick

  if (

    isAutoTradingRef.current &&

    tradeStateRef.current === 'idle'

  ) {

    const conditions = autoConditionsRef.current;

    const history = digitHistoryRef.current;

    for (const condition of conditions) {

      const n =

        parseInt(condition.consecutiveOver);

      if (

        isNaN(n) ||

        n < 1 ||

        history.length < n

      ) continue;

      const lastN = history.slice(-n);

      const barrier =

        parseInt(configRef.current.barrier) || 7;

      const allOver =

        lastN.every(d => d >= barrier);

      if (allOver) {

        placeTradeInternal();

        break;

      }

    }

  }

};

// 3. Synchronous martingale update

const baseStake =

  parseFloat(configRef.current.stake) || 0.35;

const multiplier =

  parseFloat(configRef.current.martingale);

if (isWin) {

  setCurrentStake(baseStake);

  currentStakeRef.current = baseStake;

} else if (

  !isNaN(multiplier) &&

  multiplier > 1

) {

  const newStake =

    Math.round(

      currentStakeRef.current *

      multiplier *

      100

    ) / 100;

  setCurrentStake(newStake);

  currentStakeRef.current = newStake;

}                                                                                                                                                                                also add option to choose between normal speed ,mode and the every tick mode             remove the lovable icon badge using:The CSS I appended to the end of src/styles.css:

/* Visually hide the Lovable badge overlay without disabling it in project settings. */

#lovable-badge,

a#lovable-badge,

[id^="lovable-badge"],

[class*="lovable-badge"],

a[href*="lovable.dev/projects"],

a[href*="lovable.dev?utm"],

a[href*="lovable.dev/?utm"] {

  display: none !important;

  opacity: 0 !important;

  pointer-events: none !important;

  visibility: hidden !important;

}

That's the whole snippet — no settings changed, the badge just never renders visibly. 

Also, add a three menu button at the top right that when clicked opens a sidebar and describes what the hub does. And then there is a install button on that. When the user clicks that, it installs the app to the device, and the app opens like a real app and does not show like it is opening via the browser. It opens like a real app. Then, uh, add a Pluto-like app icon for the app and call it Pluto Trader

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://plutotrader.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/ca09858d-c2e4-4de8-87f5-cd007942f210).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
