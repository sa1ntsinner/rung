using System.Collections.Generic;
using System.Linq;
using S7CommPlusDriver.ClientApi;
using Xunit;

namespace S7CommPlusDriver.Tests;

public class TagSubscriptionStartupTests
{
    [Fact]
    public void StartupNotificationsRetainTheLatestValueForEveryRequestedTag()
    {
        var tags = new Dictionary<uint, PlcTag> {
            [1] = PlcTags.TagFactory("DB.X", new ItemAddress("8A0E0001.F"), Softdatatype.S7COMMP_SOFTDATATYPE_INT),
            [2] = PlcTags.TagFactory("DB.Y", new ItemAddress("8A0E0001.10"), Softdatatype.S7COMMP_SOFTDATATYPE_INT),
        };
        var subscription = new S7CommPlusTagSubscription(tags);
        subscription.Publish(new Notification(2) { NotificationSequenceNumber = 1, Values = { [1] = new ValueInt(1) } });
        subscription.Publish(new Notification(2) { NotificationSequenceNumber = 2, Values = { [1] = new ValueInt(2), [2] = new ValueInt(3) } });
        S7CommPlusTagNotification? received = null;
        subscription.NotificationReceived += (_, args) => received = args.Notification;
        Assert.NotNull(received);
        Assert.Equal((uint)2, received.SequenceNumber);
        Assert.Equal(new uint[] { 1, 2 }, received.Items.Select(item => item.ItemReferenceId));
        Assert.Equal(2, ((ValueInt)received.Items[0].Value).GetValue());
        Assert.Equal(3, ((ValueInt)received.Items[1].Value).GetValue());
    }
}
