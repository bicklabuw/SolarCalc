**Solar Calc Basic Project Spec**

**Purpose:**

Collaborators that want to use the Insect Eavesdropper (IE) in the field
need to know how to properly power the device for their experiments.
These experiments vary significantly in length, number of devices, and
location. Given many of our collaborators are not knowledgeable about
power solutions, let alone the units of power, being able to accurately
estimate the best power solution is incredibly important.

**Goal:**

Provide a website where collaborators can accurately estimate the
necessary battery or battery + solar equipment needed to run their
desired experiment.

**Important to keep in mind:**

- Collaborators won't understand most power information. So, keeping it
  as simple as possible and explaining units / purpose behind each input
  and output value is extremely valuable.

**Tech Requirements:**

- All calculations are made locally with no backend

- API requests can be made for sunlight information

  - We can discuss ways to keep keys safe if needed

**Feature Requirements:**

Inputs:

- Number of IE Devices

- Length of Experiments (in days or weeks maybe?)

<!-- -->

- Device Split Technique (up to you to decide how to implement this)

  - If we have 16 IEs, we likely don't want to power it all off one
    battery, instead maybe we have 4 batteries powering 4 IE each

    - Or we have 4 IEs in each field, so we want 4 groups of 4 IEs

  - Can be simple to start like: User inputs number of groups

- Location (to estimate sunlight)

  - Only needed for solar (but for simplicity could be required for
    both)

Outputs:

- Per Device Group

  - Number of IE devise

  - Number of batteries needed

  - Energy Required per day (Wh)

  - Total Energy Required (Wh)

  - If just Battery:

    - Minimum battery capacity needed (Wh)

  - If Solar Enabled:

    - Solar Panel wattage needed (W)

    - Battery capacity needed with Solar

    - Estimated Sun hours per day

- Total Power (Wh) needed per day across all groups

- Total Power (Wh) used in the experiment

- Explainer on how we got to these Battery + Solar values

Algorithm:

- Add a safety margin (maybe around 30%)

UI:

- Simple and intuitive

- Non-technical researchers must understand how to get results and their
  meaning

**Useful (but Not Required) Features**

- Wh to Ah (Amp Hour) converter for Batteries needed (Wh = Ah \* V)
  where V is Voltage (input)

  - Battery capacities are commonly in Ah or Wh

- More advanced split technique / algorithm:

  - Are devices split across fields / distances (longer than maybe \~30
    FT)?

    - If so, how do we represent all the devices split

    - What inputs do we need to know this?

    - Make it clear you don't want a single battery to power multiple
      devices that are far from one another

- Have an adjustable safety margin



**Power Information:**

- Each IE uses just under 100 Wh per day

  - About 4 Wh per hour

- So total power used should be:

  - `#\_of_IE x 100Wh x Experiment_Length_in_Days`