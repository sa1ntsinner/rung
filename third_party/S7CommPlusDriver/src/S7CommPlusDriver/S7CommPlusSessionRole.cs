namespace S7CommPlusDriver
{
    /// <summary>
    /// Identifies the client role used when establishing an S7CommPlus session.
    /// </summary>
    public enum S7CommPlusSessionRole
    {
        /// <summary>
        /// Uses the HMI endpoint.
        /// </summary>
        Hmi = 0,

        /// <summary>
        /// Uses the engineering-system endpoint.
        /// </summary>
        EngineeringSystem = 1
    }
}

